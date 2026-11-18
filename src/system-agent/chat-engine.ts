import type {
  SystemAgentChatParams,
  SystemAgentWizardCancel,
  WizardAnswer,
} from "../../packages/gateway-protocol/src/index.js";
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../agents/prepared-model-runtime-generation-scope.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  cleanupSystemAgentSession,
  createSystemAgentSession,
  runSystemAgentTurn,
  type SystemAgentSession,
  type SystemAgentTurnRunner,
} from "./agent-turn.js";
import type { SystemAgentApprovalClassifier } from "./approval-intent.js";
import type { SystemAgentAssistantTurn } from "./assistant.js";
import {
  ChatWizardHost,
  type ChatWizardResult,
  type SystemAgentChatReply,
} from "./chat-wizard-host.js";
import {
  applyTurnDirective,
  agentHandoffReturnHint,
  approvalQuestion,
  createCaptureRuntime,
  formatSystemAgentTurnInput,
  finishSystemAgentPersistentOperation,
  resolveSystemAgentConfigWriteRepair,
  verifySystemAgentConfigAfterWrite,
  type CaptureRuntime,
} from "./dialogue.js";
import type { SystemAgentGreetingPlanner } from "./greeting.js";
import {
  SystemAgentInferenceUnavailableError,
  isSystemAgentInferenceUnavailableError,
} from "./inference-error.js";
import {
  requireSystemAgentInferenceRoute,
  requireSystemAgentPersistentApplyInference,
} from "./inference-guard.js";
import { isSystemAgentNavigationOperation } from "./operation-types.js";
import {
  getRegularAgentSetupNotice,
  resolveTuiAgentId,
  SystemAgentOperationExitError,
} from "./operations-execution-helpers.js";
import { isInvalidConfigSetOperation } from "./operations-internal.js";
import {
  describeSystemAgentPersistentOperation,
  executeSystemAgentOperation,
  isPersistentSystemAgentOperation,
  parseSystemAgentConfigCommand,
  parseSystemAgentOperation,
  redactSensitiveCommandText,
  SYSTEM_AGENT_OPERATOR_NAVIGATION_HANDOFF,
  type SystemAgentCommandDeps,
  type SystemAgentOperation,
  type SystemAgentOperatorProposal,
  type SystemAgentOperationResult,
} from "./operations.js";
import {
  hashSystemAgentOperation,
  classifySystemAgentApprovalText,
  resolveOperatorApprovalDecision,
  resolvePendingOperatorProposal,
  SYSTEM_AGENT_APPROVAL_APPLICATION_UNCONFIRMED_TEXT,
  SYSTEM_AGENT_APPROVAL_TERMINAL_MESSAGES,
  type SystemAgentApprovalIntent,
} from "./operator-approval.js";
import { loadSystemAgentOverview, type SystemAgentOverview } from "./overview.js";
import type { SystemAgentVerifiedInferenceBinding } from "./verified-inference.js";

export { SystemAgentWizardAnswerError } from "./chat-wizard-host.js";

export type SystemAgentChatTurnOptions = {
  uiContext?: SystemAgentChatParams["context"];
};

export type SystemAgentChatEngineOptions = {
  readonly verifiedInference?: SystemAgentVerifiedInferenceBinding;
  /** Prepare a real inference binding only when conversational work needs it. */
  prepareInference?: () => Promise<SystemAgentVerifiedInferenceBinding>;
  yes?: boolean;
  deps?: SystemAgentCommandDeps;
  runAgentTurn?: SystemAgentTurnRunner;
  classifyApproval?: SystemAgentApprovalClassifier;
  surface?: "cli" | "gateway";
  operatorApprovalOnly?: boolean;
  requesterAgentId?: string;
};

type PersistentApplyGuard = () => void;

export class SystemAgentChatEngine {
  private readonly history: SystemAgentAssistantTurn[] = [];
  private inference?: {
    binding: SystemAgentVerifiedInferenceBinding;
    session: SystemAgentSession;
  };
  private readonly wizard: ChatWizardHost;
  private pending: SystemAgentOperation | null = null;
  private pendingExactConfig = false;
  private pendingDescription?: string;
  private proposalResolution: "approved" | "declined" | undefined;
  private turnQueue: Promise<unknown> = Promise.resolve();

  private get inferenceRuntime() {
    if (!this.inference) {
      throw new SystemAgentInferenceUnavailableError("conversation");
    }
    return this.inference;
  }

  constructor(private readonly options: SystemAgentChatEngineOptions) {
    const binding = options?.verifiedInference;
    if (!binding && !options?.prepareInference) {
      throw new SystemAgentInferenceUnavailableError("conversation");
    }
    if (binding) {
      this.inference = { binding, session: createSystemAgentSession(binding) };
    }
    this.wizard = new ChatWizardHost({
      surface: options.surface,
      beforePersistentApply: async (runtime) => {
        await this.requirePersistentApplyInference(runtime);
      },
    });
  }

  propose(operation: SystemAgentOperation): string {
    this.clearPendingProposals();
    this.pending = this.recordCreateAgentRequester(operation);
    return describeSystemAgentPersistentOperation(this.pending);
  }

  getPendingOperatorProposal(): SystemAgentOperatorProposal | null {
    const proposal = resolvePendingOperatorProposal(
      this.pending,
      this.inference?.session.proposalRef ?? {},
    );
    if (!proposal) {
      return null;
    }
    const operation = this.recordCreateAgentRequester(proposal.operation);
    // Request provenance participates in approval identity, but reading the
    // operator projection must not transfer ownership of a host-seeded plan.
    const described = this.pendingDescription
      ? { ...proposal, description: this.pendingDescription }
      : proposal;
    return operation === proposal.operation
      ? described
      : { ...described, operation, hash: hashSystemAgentOperation(operation) };
  }

  async resolveOperatorApproval(
    decision: "allow-once" | "allow-always" | "deny" | null,
    proposalHash: string,
    beforePersistentApply?: () => void,
    terminalStatus?: "expired" | "cancelled",
  ): Promise<SystemAgentChatReply | null> {
    return await this.enqueueTurn(async () => {
      // Approval consumes pending state before applying. Retain its host-owned provenance.
      const exactConfig = this.pendingExactConfig;
      const reply = await resolveOperatorApprovalDecision<SystemAgentChatReply>({
        decision,
        proposalHash,
        getProposal: () => this.getPendingOperatorProposal(),
        clear: () => this.clearPendingProposals(),
        apply: async (operation) => {
          this.proposalResolution = "approved";
          return await this.applyApprovedPersistentOperation(
            operation,
            beforePersistentApply,
            exactConfig,
          );
        },
        denied: () => {
          this.proposalResolution = "declined";
          return { text: "Denied. No change.", action: "none" as const, applied: false };
        },
      });
      if (reply && terminalStatus && !reply.applied) {
        reply.text = SYSTEM_AGENT_APPROVAL_TERMINAL_MESSAGES[terminalStatus];
      }
      const reviewingPlugin =
        this.pending?.kind === "plugin-install" && this.pending.capabilityReview;
      if (reply && decision === "allow-once" && !reply.applied && !reviewingPlugin) {
        reply.text += ` ${SYSTEM_AGENT_APPROVAL_APPLICATION_UNCONFIRMED_TEXT}`;
      }
      if (reply?.text) {
        this.history.push({ role: "assistant", text: reply.text });
      }
      return reply;
    });
  }

  noteAssistantMessage(text: string): void {
    this.history.push({ role: "assistant", text });
  }

  seedHistory(turns: readonly SystemAgentAssistantTurn[]): void {
    this.history.push(
      ...turns.map((turn) => ({
        ...turn,
        text: turn.role === "user" ? redactSensitiveCommandText(turn.text) : turn.text,
      })),
    );
  }

  historyLength(): number {
    return this.history.length;
  }

  historySince(index: number): SystemAgentAssistantTurn[] {
    return this.history.slice(index).map((turn) => ({ role: turn.role, text: turn.text }));
  }

  async dispose(): Promise<void> {
    this.wizard.dispose();
    if (this.inference) {
      await cleanupSystemAgentSession(this.inference.session);
    }
  }

  /**
   * Project the live hosted-wizard interaction onto a rejoin reply so a
   * reconnecting client re-renders the answer controls this session still
   * awaits; a no-op when no wizard is active.
   */
  decorateRejoinReply(reply: SystemAgentChatReply): SystemAgentChatReply {
    return this.wizard.decorateReply(reply);
  }

  async handle(text: string, options?: SystemAgentChatTurnOptions): Promise<SystemAgentChatReply> {
    return await this.enqueueTurn(async () => {
      const exactConfig =
        !this.wizard.active &&
        (parseSystemAgentConfigCommand(text) ||
          (this.pendingExactConfig && classifySystemAgentApprovalText(text) !== "other"));
      const delegatedApprovalPending =
        !this.wizard.active &&
        this.options.operatorApprovalOnly &&
        this.getPendingOperatorProposal();
      if (!exactConfig && !delegatedApprovalPending) {
        await this.requireVerifiedInference();
      }
      const sensitiveTurn = this.wizard.sensitiveInputPending;
      const reply = await this.resolveTurn(text, options);
      return this.completeTurn(
        reply,
        sensitiveTurn ? "<redacted secret>" : redactSensitiveCommandText(text),
      );
    });
  }

  async answerWizard(answer: WizardAnswer): Promise<SystemAgentChatReply> {
    return await this.enqueueTurn(async () => {
      await this.requireVerifiedInference();
      const result = await this.wizard.answer(answer);
      return this.completeTurn(
        { text: await this.finishWizardText(result), action: "none" },
        result.userHistoryText,
      );
    });
  }

  async cancelWizard(cancel: SystemAgentWizardCancel): Promise<SystemAgentChatReply> {
    return await this.enqueueTurn(async () => {
      const result = await this.wizard.cancel(cancel);
      return this.completeTurn(
        { text: await this.finishWizardText(result), action: "none" },
        result.userHistoryText,
      );
    });
  }

  private enqueueTurn<T>(run: () => Promise<T>): Promise<T> {
    const turn = this.turnQueue.then(run);
    this.turnQueue = turn.catch(() => undefined);
    return turn;
  }

  private completeTurn(reply: SystemAgentChatReply, userHistoryText: string): SystemAgentChatReply {
    const completed = this.wizard.decorateReply(reply);
    this.history.push({ role: "user", text: userHistoryText });
    if (completed.text) {
      this.history.push({ role: "assistant", text: completed.text });
    }
    return completed;
  }

  async loadOverview(): Promise<SystemAgentOverview> {
    const route = await this.requireVerifiedInference();
    const overview = await (this.options.deps?.loadOverview ?? loadSystemAgentOverview)({
      agentId: route.agentId,
    });
    return route.modelTarget === "utility"
      ? { ...overview, setupModel: route.modelLabel }
      : { ...overview, defaultModel: route.modelLabel };
  }

  async planGreeting(
    params: Parameters<SystemAgentGreetingPlanner>[0],
  ): ReturnType<SystemAgentGreetingPlanner> {
    await this.requireVerifiedInference();
    const runPlanner = async () =>
      await import("./assistant.js").then(({ planSystemAgentGreetingWithConfiguredModel }) =>
        planSystemAgentGreetingWithConfiguredModel({
          ...params,
          verifiedInference: this.inferenceRuntime.binding,
        }),
      );
    const requesterAgentId = this.options.requesterAgentId?.trim();
    const plan =
      requesterAgentId && requesterAgentId !== this.inferenceRuntime.binding.execution.agentId
        ? await runOutsidePreparedModelRuntimePluginGenerationScope(runPlanner)
        : await runPlanner();
    if (plan) {
      await this.requireVerifiedInference();
    }
    return plan;
  }

  private async requireVerifiedInference() {
    await this.prepareInferenceSession();
    const binding = this.inferenceRuntime.binding;
    if (this.inferenceRuntime.session.verifiedInference !== binding) {
      return this.throwInferenceUnavailable();
    }
    return await requireSystemAgentInferenceRoute(binding, "conversation", (failures) =>
      this.throwInferenceUnavailable(failures),
    );
  }

  private async requirePersistentApplyInference(runtime: RuntimeEnv) {
    await this.prepareInferenceSession();
    const binding = this.inferenceRuntime.binding;
    if (this.inferenceRuntime.session.verifiedInference !== binding) {
      return this.throwInferenceUnavailable();
    }
    return await requireSystemAgentPersistentApplyInference({ binding, runtime }, (failures) =>
      this.throwInferenceUnavailable(
        isSystemAgentInferenceUnavailableError(failures[0]) ? failures[0].failures : failures,
        false,
      ),
    );
  }

  private async prepareInferenceSession(): Promise<void> {
    if (!this.inference) {
      const binding = await this.options.prepareInference?.();
      if (!binding) {
        throw new SystemAgentInferenceUnavailableError("conversation");
      }
      this.inference = { binding, session: createSystemAgentSession(binding) };
    }
  }

  private rebindVerifiedInference(binding: SystemAgentVerifiedInferenceBinding): void {
    if (binding.execution.agentId !== this.inferenceRuntime.binding.execution.agentId) {
      return;
    }
    delete this.inferenceRuntime.session.cliSession;
    this.inference = { binding, session: this.inferenceRuntime.session };
    this.inferenceRuntime.session.verifiedInference = binding;
  }

  private throwInferenceUnavailable(failures: readonly unknown[] = [], cancelWizard = true): never {
    this.clearPendingProposals();
    this.proposalResolution = undefined;
    this.wizard.clearHandoff();
    if (this.inference) {
      delete this.inference.session.cliSession;
    }
    if (cancelWizard) {
      this.wizard.dispose();
    }
    this.history.splice(0);
    throw new SystemAgentInferenceUnavailableError("conversation", failures, "route-changed");
  }

  private async resolveTurn(
    text: string,
    options?: SystemAgentChatTurnOptions,
  ): Promise<SystemAgentChatReply> {
    if (this.wizard.active) {
      const result = await this.wizard.resolveReply(text);
      return { text: await this.finishWizardText(result), action: "none" };
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return {
        text: "Tiny claw tap: tell me what you want — setup, repair, channels, anything config.",
        action: "none",
      };
    }
    if (/^(quit|exit)$/i.test(trimmed)) {
      return { text: "OpenClaw retracts into shell. Bye.", action: "exit" };
    }
    const channelHandoff = this.wizard.resolveChannelHandoffInput(trimmed);
    if (channelHandoff) {
      return "kind" in channelHandoff ? await this.runOperation(channelHandoff) : channelHandoff;
    }
    if (this.options.operatorApprovalOnly && this.getPendingOperatorProposal()) {
      return { text: "Approval pending. Human must decide in OpenClaw UI.", action: "none" };
    }
    const configCommand = parseSystemAgentConfigCommand(text);
    if (configCommand) {
      return isInvalidConfigSetOperation(configCommand)
        ? { text: configCommand.message, action: "none" }
        : await this.runOperation(configCommand, true);
    }
    const typed = parseSystemAgentOperation(text);
    if (isSystemAgentNavigationOperation(typed)) {
      return await this.runOperation(typed);
    }

    const intent = this.options.operatorApprovalOnly
      ? "other"
      : await this.classifyApprovalIntent(text);
    if (this.pending) {
      if (intent === "approve") {
        if (!this.pendingExactConfig) {
          await this.requireVerifiedInference();
        }
        return await this.applyPendingProposal(this.pending);
      }
      if (intent === "decline") {
        this.clearPendingProposals();
        this.proposalResolution = "declined";
        return {
          text: "Skipped. No barnacles on config today.",
          action: "none",
        };
      }
    }
    if (intent === "decline") {
      this.inferenceRuntime.session.proposalRef.current = undefined;
      this.inferenceRuntime.session.proposalRef.operation = undefined;
    }
    return await this.resolveAssistantTurn(
      text,
      this.options.operatorApprovalOnly ? false : intent === "approve",
      options?.uiContext,
    );
  }

  private async classifyApprovalIntent(text: string): Promise<SystemAgentApprovalIntent> {
    const literal = classifySystemAgentApprovalText(text);
    if (this.pendingExactConfig && literal !== "other") {
      return literal;
    }
    const hasProposal =
      this.pending !== null || this.inferenceRuntime.session.proposalRef.current !== undefined;
    if (!hasProposal) {
      return "other";
    }
    const classify =
      this.options.classifyApproval ??
      (await import("./approval-intent.js")).classifySystemAgentApprovalIntent;
    return await classify({
      message: text,
      ...(this.pending ? { proposal: describeSystemAgentPersistentOperation(this.pending) } : {}),
      verifiedInference: this.inferenceRuntime.binding,
    });
  }

  private async applyPendingProposal(pending: SystemAgentOperation): Promise<SystemAgentChatReply> {
    const exactConfig = this.pendingExactConfig;
    this.clearPendingProposals();
    this.proposalResolution = "approved";
    return await this.applyApprovedPersistentOperation(pending, undefined, exactConfig);
  }

  private async applyApprovedPersistentOperation(
    operation: SystemAgentOperation,
    beforePersistentApply?: PersistentApplyGuard,
    exactConfig = false,
  ): Promise<SystemAgentChatReply> {
    if (!isPersistentSystemAgentOperation(operation)) {
      throw new Error("OpenClaw host received a non-persistent approved operation.");
    }
    const capture = createCaptureRuntime();
    const result = await this.executeOperation(
      operation,
      capture,
      beforePersistentApply,
      exactConfig,
    );
    if (operation.kind === "plugin-install" && result?.pluginCapabilityReview) {
      return await this.runOperation({
        ...operation,
        capabilityReview: result.pluginCapabilityReview,
      });
    }
    const reply = await finishSystemAgentPersistentOperation({
      operation,
      result,
      text: capture.read(),
      exactConfig,
      surface: this.options.surface,
      resolveAssistantTurn: (text) => this.resolveAssistantTurn(text, false),
      loadOverview: () => this.loadOverview(),
    });
    if (operation.kind === "template-install") {
      this.inferenceRuntime.session.templateResult = reply.text;
    }
    return reply;
  }

  private async resolveAssistantTurn(
    text: string,
    approvalArmed: boolean,
    uiContext?: SystemAgentChatParams["context"],
  ): Promise<SystemAgentChatReply> {
    await this.requireVerifiedInference();
    const agentTurn = this.options.runAgentTurn ?? runSystemAgentTurn;
    const loopInput = formatSystemAgentTurnInput(
      text,
      this.pending,
      this.proposalResolution,
      uiContext,
      this.inferenceRuntime.session.templateResult,
    );
    // The runtime already owns recovery; a terminal failure must not start another inference turn.
    const runTurn = () =>
      agentTurn({
        input: loopInput,
        surface: this.options.surface ?? "cli",
        approvalArmed,
        ...(this.options.operatorApprovalOnly ? { operatorApprovalOnly: true } : {}),
        session: this.inferenceRuntime.session,
      });
    const requesterAgentId = this.options.requesterAgentId?.trim();
    const loopReply =
      requesterAgentId &&
      requesterAgentId !== this.inferenceRuntime.session.verifiedInference.execution.agentId
        ? await runOutsidePreparedModelRuntimePluginGenerationScope(runTurn)
        : await runTurn();
    if (!loopReply?.text) {
      throw new SystemAgentInferenceUnavailableError("agent-turn");
    }
    this.proposalResolution = undefined;
    if (loopReply.directive) {
      this.clearPendingProposals();
    } else if (this.inferenceRuntime.session.proposalRef.current !== undefined) {
      this.pending = null;
      this.pendingExactConfig = false;
      this.pendingDescription = undefined;
    }
    await this.requireVerifiedInference();
    const reply = await applyTurnDirective({
      loopReply,
      runOperation: (operation) => this.runOperation(operation),
      applyApproved: (operation) => this.applyApprovedPersistentOperation(operation),
    });
    if (loopReply.directive?.kind === "template-operation") {
      this.inferenceRuntime.session.templateResult = reply.text;
    }
    return reply;
  }

  private async runOperation(
    operation: SystemAgentOperation,
    exactConfig = false,
  ): Promise<SystemAgentChatReply> {
    const recordedOperation = this.recordCreateAgentRequester(operation);
    if (!exactConfig) {
      await this.requireVerifiedInference();
    }
    // All inputs (typed commands and tool directives) enter
    // here before any wizard or handoff starts.
    if (this.options.operatorApprovalOnly && isSystemAgentNavigationOperation(recordedOperation)) {
      return {
        text: SYSTEM_AGENT_OPERATOR_NAVIGATION_HANDOFF,
        action: "none",
      };
    }
    if (recordedOperation.kind === "open-tui") {
      this.clearPendingProposals();
      const overview = await this.loadOverview();
      const setupNotice = getRegularAgentSetupNotice(
        overview,
        resolveTuiAgentId({
          requestedAgentId: recordedOperation.agentId,
          requestedWorkspace: recordedOperation.workspace,
          overview,
        }),
      );
      if (setupNotice) {
        return { text: setupNotice, action: "none" };
      }
      return {
        text: `Opening a chat with your agent. ${agentHandoffReturnHint(this.options.surface)}`,
        action: "open-tui",
        handoff: recordedOperation,
      };
    }
    if (recordedOperation.kind === "model-accounts") {
      this.clearPendingProposals();
      return {
        text:
          this.options.surface === "gateway"
            ? "Opening Settings → Profile → Connected accounts. Check the Gateway, person, and Personal scope, then sign in or select a saved account. Nothing has changed yet."
            : "Run `openclaw models accounts list` to see your personal accounts, or `openclaw models accounts login <provider>` for protected sign-in. Check the Gateway and person shown before signing in. You can also use Settings → Profile → Connected accounts in the Control UI. Nothing has changed.",
        action: "none",
        ...(this.options.surface === "gateway" ? { handoff: recordedOperation } : {}),
      };
    }
    if (recordedOperation.kind === "open-setup") {
      this.clearPendingProposals();
      return this.wizard.openSetup(recordedOperation);
    }
    if (recordedOperation.kind === "channel-setup") {
      return await this.startWizard(this.wizard.startChannel(recordedOperation.channel));
    }
    if (recordedOperation.kind === "skills-setup") {
      return await this.startWizard(this.wizard.startSetup("skills"));
    }
    if (recordedOperation.kind === "search-setup") {
      return await this.startWizard(this.wizard.startSetup("search"));
    }
    if (recordedOperation.kind === "gateway-config-setup") {
      return await this.startWizard(this.wizard.startSetup("gateway"));
    }
    if (recordedOperation.kind === "memory-import") {
      return await this.startWizard(this.wizard.startMemoryImport());
    }
    if (recordedOperation.kind === "model-setup") {
      this.clearPendingProposals();
      const capture = createCaptureRuntime();
      await executeSystemAgentOperation(recordedOperation, capture);
      return { text: capture.read(), action: "none" };
    }

    const capture = createCaptureRuntime();
    if (
      isPersistentSystemAgentOperation(recordedOperation) &&
      (!this.options.yes ||
        (recordedOperation.kind === "plugin-install" && recordedOperation.capabilityReview))
    ) {
      this.clearPendingProposals();
      // Validate through the executor before staging; delegated handoff copy must
      // not turn a forbidden operation into an approvable proposal.
      const proposal = await executeSystemAgentOperation(recordedOperation, capture, {
        approved: false,
        operatorApprovalOnly: this.options.operatorApprovalOnly,
        deps: this.commandDeps(),
      });
      this.pending = recordedOperation;
      this.pendingExactConfig = exactConfig;
      if (recordedOperation.kind === "template-install") {
        this.pendingDescription = proposal.message;
      }
      return {
        text: [
          capture.read(),
          this.options.operatorApprovalOnly ? undefined : approvalQuestion(recordedOperation),
        ]
          .filter(Boolean)
          .join("\n\n"),
        action: "none",
      };
    }
    if (isPersistentSystemAgentOperation(recordedOperation)) {
      return await this.applyApprovedPersistentOperation(recordedOperation, undefined, exactConfig);
    }
    const result = await this.executeOperation(recordedOperation, capture, undefined, exactConfig);
    const reply = capture.read();
    if (result?.exitsInteractive === true) {
      return { text: reply, action: "exit" };
    }
    return { text: reply, action: "none" };
  }

  private async executeOperation(
    operation: SystemAgentOperation,
    capture: CaptureRuntime,
    beforePersistentApply?: PersistentApplyGuard,
    exactConfig = false,
  ): Promise<SystemAgentOperationResult | undefined> {
    try {
      if (!exactConfig) {
        await this.requirePersistentApplyInference(capture);
      }
      return await executeSystemAgentOperation(operation, capture, {
        approved: true,
        ...(this.options.requesterAgentId
          ? { requesterAgentId: this.options.requesterAgentId }
          : {}),
        deps: this.commandDeps(),
        beforePersistentApply,
        onVerifiedInferenceChanged: (binding) => this.rebindVerifiedInference(binding),
      });
    } catch (error) {
      if (isSystemAgentInferenceUnavailableError(error)) {
        throw error;
      }
      if (!(error instanceof SystemAgentOperationExitError)) {
        const message = error instanceof Error ? error.message : String(error);
        capture.error(`That did not go through: ${message}`);
      }
      return undefined;
    }
  }

  private async startWizard(result: Promise<ChatWizardResult>): Promise<SystemAgentChatReply> {
    this.clearPendingProposals();
    const resolved = await result;
    return { text: await this.finishWizardText(resolved), action: "none" };
  }

  private async finishWizardText(result: ChatWizardResult): Promise<string> {
    const verify = result.configWritten
      ? await verifySystemAgentConfigAfterWrite((issuesText, applied) =>
          resolveSystemAgentConfigWriteRepair(issuesText, applied, (text) =>
            this.resolveAssistantTurn(text, false),
          ),
        )
      : null;
    return [result.text, verify].filter(Boolean).join("\n");
  }

  private commandDeps(): SystemAgentCommandDeps {
    return {
      ...this.options.deps,
      loadOverview: async () => await this.loadOverview(),
      ...(this.options.surface ? { setupSurface: this.options.surface } : {}),
    };
  }

  private clearPendingProposals(): void {
    this.pending = null;
    this.pendingExactConfig = false;
    this.pendingDescription = undefined;
    if (this.inference) {
      this.inference.session.proposalRef.current = undefined;
      this.inference.session.proposalRef.operation = undefined;
    }
  }

  private recordCreateAgentRequester(operation: SystemAgentOperation): SystemAgentOperation {
    const requesterAgentId = this.options.requesterAgentId?.trim();
    if (
      operation.kind !== "create-agent" ||
      !requesterAgentId ||
      operation.requesterAgentId === requesterAgentId
    ) {
      return operation;
    }
    return { ...operation, requesterAgentId };
  }
}
