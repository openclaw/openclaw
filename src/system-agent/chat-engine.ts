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
  type SystemAgentTurnDirective,
  type SystemAgentTurnRunner,
} from "./agent-turn.js";
import type { SystemAgentApprovalClassifier } from "./approval-intent.js";
import type { SystemAgentAssistantTurn } from "./assistant.js";
import {
  ChatWizardHost,
  type ChatWizardResult,
  type SystemAgentChatReply,
} from "./chat-wizard-host.js";
import { approvalQuestion, formatSystemAgentTurnInput } from "./dialogue.js";
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
  parseSystemAgentOperation,
  redactSensitiveCommandText,
  SYSTEM_AGENT_OPERATOR_NAVIGATION_HANDOFF,
  type SystemAgentCommandDeps,
  type SystemAgentOperation,
  type SystemAgentOperationResult,
} from "./operations.js";
import {
  hashSystemAgentOperation,
  resolveOperatorApprovalDecision,
  resolvePendingOperatorProposal,
  SYSTEM_AGENT_APPROVAL_APPLICATION_UNCONFIRMED_TEXT,
  SYSTEM_AGENT_APPROVAL_TERMINAL_MESSAGES,
  type SystemAgentApprovalIntent,
} from "./operator-approval.js";
import { loadSystemAgentOverview, type SystemAgentOverview } from "./overview.js";
import {
  resolveConfigWriteRepair,
  verifyConfigAfterSystemAgentWrite,
} from "./post-write-verification.js";
import type { SystemAgentVerifiedInferenceBinding } from "./verified-inference.js";

export { SystemAgentWizardAnswerError } from "./chat-wizard-host.js";

export type SystemAgentChatTurnOptions = {
  uiContext?: SystemAgentChatParams["context"];
};

export type SystemAgentChatEngineOptions = {
  planGreeting?: SystemAgentGreetingPlanner;
  readonly verifiedInference: SystemAgentVerifiedInferenceBinding;
  yes?: boolean;
  deps?: SystemAgentCommandDeps;
  runAgentTurn?: SystemAgentTurnRunner;
  classifyApproval?: SystemAgentApprovalClassifier;
  surface?: "cli" | "gateway";
  operatorApprovalOnly?: boolean;
  requesterAgentId?: string;
};

type CaptureRuntime = RuntimeEnv & { read: () => string };
type PersistentApplyGuard = () => void;

function createCaptureRuntime(): CaptureRuntime {
  const lines: string[] = [];
  return {
    log: (...args) => lines.push(args.join(" ")),
    error: (...args) => lines.push(args.join(" ")),
    exit: (code) => {
      throw new Error(`OpenClaw operation exited with code ${String(code)}`);
    },
    read: () => lines.join("\n").trim(),
  };
}

export class SystemAgentChatEngine {
  private readonly history: SystemAgentAssistantTurn[] = [];
  private readonly agentSession: SystemAgentSession;
  private readonly wizard: ChatWizardHost;
  private pending: SystemAgentOperation | null = null;
  private proposalResolution: "approved" | "declined" | undefined;
  private verifiedInference: SystemAgentVerifiedInferenceBinding;
  private turnQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SystemAgentChatEngineOptions) {
    const binding = options?.verifiedInference;
    if (!binding) {
      throw new SystemAgentInferenceUnavailableError("conversation");
    }
    this.verifiedInference = binding;
    this.agentSession = createSystemAgentSession(binding);
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

  getPendingOperatorProposal(): { operation: SystemAgentOperation; hash: string } | null {
    const proposal = resolvePendingOperatorProposal(this.pending, this.agentSession.proposalRef);
    if (!proposal) {
      return null;
    }
    const operation = this.recordCreateAgentRequester(proposal.operation);
    // Request provenance participates in approval identity, but reading the
    // operator projection must not transfer ownership of a host-seeded plan.
    return operation === proposal.operation
      ? proposal
      : { operation, hash: hashSystemAgentOperation(operation) };
  }

  async resolveOperatorApproval(
    decision: "allow-once" | "allow-always" | "deny" | null,
    proposalHash: string,
    beforePersistentApply?: () => void,
    terminalStatus?: "expired" | "cancelled",
  ): Promise<SystemAgentChatReply | null> {
    return await this.enqueueTurn(async () => {
      const reply = await resolveOperatorApprovalDecision<SystemAgentChatReply>({
        decision,
        proposalHash,
        getProposal: () => this.getPendingOperatorProposal(),
        clear: () => this.clearPendingProposals(),
        apply: async (operation) => {
          this.proposalResolution = "approved";
          return await this.applyApprovedPersistentOperation(operation, beforePersistentApply);
        },
        denied: () => {
          this.proposalResolution = "declined";
          return { text: "Denied. No change.", action: "none" as const, applied: false };
        },
      });
      if (reply && terminalStatus && !reply.applied) {
        reply.text = SYSTEM_AGENT_APPROVAL_TERMINAL_MESSAGES[terminalStatus];
      }
      if (reply && decision === "allow-once" && !reply.applied) {
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
    await cleanupSystemAgentSession(this.agentSession);
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
      await this.requireVerifiedInference();
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
    const runPlanner = async () => {
      const planner = this.options.planGreeting;
      return planner
        ? await planner(params)
        : await import("./assistant.js").then(({ planSystemAgentGreetingWithConfiguredModel }) =>
            planSystemAgentGreetingWithConfiguredModel({
              ...params,
              verifiedInference: this.verifiedInference,
              deps: this.options.deps,
            }),
          );
    };
    const requesterAgentId = this.options.requesterAgentId?.trim();
    const plan =
      requesterAgentId && requesterAgentId !== this.verifiedInference.execution.agentId
        ? await runOutsidePreparedModelRuntimePluginGenerationScope(runPlanner)
        : await runPlanner();
    if (plan) {
      await this.requireVerifiedInference();
    }
    return plan;
  }

  private async requireVerifiedInference() {
    const binding = this.verifiedInference;
    if (this.agentSession.verifiedInference !== binding) {
      return this.throwInferenceUnavailable();
    }
    return await requireSystemAgentInferenceRoute(
      binding,
      this.options.deps,
      "conversation",
      (failures) => this.throwInferenceUnavailable(failures),
    );
  }

  private async requirePersistentApplyInference(runtime: RuntimeEnv) {
    const binding = this.verifiedInference;
    if (this.agentSession.verifiedInference !== binding) {
      return this.throwInferenceUnavailable();
    }
    return await requireSystemAgentPersistentApplyInference({ binding, runtime }, (failures) =>
      this.throwInferenceUnavailable(
        isSystemAgentInferenceUnavailableError(failures[0]) ? failures[0].failures : failures,
        false,
      ),
    );
  }

  private rebindVerifiedInference(binding: SystemAgentVerifiedInferenceBinding): void {
    if (binding.execution.agentId !== this.verifiedInference.execution.agentId) {
      return;
    }
    delete this.agentSession.cliSession;
    this.verifiedInference = binding;
    this.agentSession.verifiedInference = binding;
  }

  private throwInferenceUnavailable(failures: readonly unknown[] = [], cancelWizard = true): never {
    this.clearPendingProposals();
    this.proposalResolution = undefined;
    this.wizard.clearHandoff();
    delete this.agentSession.cliSession;
    if (cancelWizard) {
      this.wizard.dispose();
    }
    this.history.splice(0);
    throw new SystemAgentInferenceUnavailableError("conversation", failures, "route-changed");
  }

  private async verifyConfigAfterWrite(): Promise<string | null> {
    return await verifyConfigAfterSystemAgentWrite((message) =>
      this.resolveAssistantTurn(message, false),
    );
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
    const typed = parseSystemAgentOperation(text);
    if (isInvalidConfigSetOperation(typed)) {
      return { text: typed.message, action: "none" };
    }
    if (
      typed.kind === "config-set" ||
      typed.kind === "config-unset" ||
      typed.kind === "config-set-ref" ||
      typed.kind === "config-get" ||
      typed.kind === "config-schema"
    ) {
      return await this.runOperation(typed);
    }
    if (isSystemAgentNavigationOperation(typed)) {
      return await this.runOperation(typed);
    }

    const intent = this.options.operatorApprovalOnly
      ? "other"
      : await this.classifyApprovalIntent(text);
    if (this.pending) {
      if (intent === "approve") {
        await this.requireVerifiedInference();
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
      this.agentSession.proposalRef.current = undefined;
      this.agentSession.proposalRef.operation = undefined;
    }
    return await this.resolveAssistantTurn(
      text,
      this.options.operatorApprovalOnly ? false : intent === "approve",
      options?.uiContext,
    );
  }

  private async classifyApprovalIntent(text: string): Promise<SystemAgentApprovalIntent> {
    const hasProposal =
      this.pending !== null || this.agentSession.proposalRef.current !== undefined;
    if (!hasProposal) {
      return "other";
    }
    const classify =
      this.options.classifyApproval ??
      (await import("./approval-intent.js")).classifySystemAgentApprovalIntent;
    return await classify({
      message: text,
      ...(this.pending ? { proposal: describeSystemAgentPersistentOperation(this.pending) } : {}),
      verifiedInference: this.verifiedInference,
    });
  }

  private async applyPendingProposal(pending: SystemAgentOperation): Promise<SystemAgentChatReply> {
    this.clearPendingProposals();
    this.proposalResolution = "approved";
    return await this.applyApprovedPersistentOperation(pending);
  }

  private async applyApprovedPersistentOperation(
    operation: SystemAgentOperation,
    beforePersistentApply?: PersistentApplyGuard,
  ): Promise<SystemAgentChatReply> {
    if (!isPersistentSystemAgentOperation(operation)) {
      throw new Error("OpenClaw host received a non-persistent approved operation.");
    }
    const capture = createCaptureRuntime();
    const result = await this.executeOperation(operation, capture, beforePersistentApply);
    const configWrite =
      operation.kind === "config-set" ||
      operation.kind === "config-unset" ||
      operation.kind === "config-set-ref";
    if (configWrite && result === undefined) {
      return {
        text: await resolveConfigWriteRepair(capture.read(), (message) =>
          this.resolveAssistantTurn(message, false),
        ),
        action: "none",
        applied: false,
      };
    }
    const verify = result?.applied ? await this.verifyConfigAfterWrite() : null;
    const baseText = [capture.read() || "Applied. Audit entry written.", verify]
      .filter(Boolean)
      .join("\n\n");
    if (
      (operation.kind === "setup" || operation.kind === "create-agent") &&
      result?.applied &&
      result.bootstrapPending === true &&
      verify === null
    ) {
      const setupNotice = getRegularAgentSetupNotice(await this.loadOverview(), result.agentId);
      if (setupNotice) {
        return { text: `${baseText}\n\n${setupNotice}`, action: "none", applied: true };
      }
      return {
        text: [
          baseText,
          `Your agent is hatching — handing you over now. ${this.agentHandoffReturnHint()}`,
        ].join("\n\n"),
        action: "open-tui",
        applied: true,
        agentDraft: "hatch",
        handoff: {
          kind: "open-tui",
          agentDraft: "hatch",
          ...(operation.workspace ? { workspace: operation.workspace } : {}),
          ...(result.agentId ? { agentId: result.agentId } : {}),
        },
      };
    }
    return { text: baseText, action: "none", applied: result?.applied === true };
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
    );
    // The runtime already owns recovery; a terminal failure must not start another inference turn.
    const runTurn = () =>
      agentTurn({
        input: loopInput,
        surface: this.options.surface ?? "cli",
        approvalArmed,
        ...(this.options.operatorApprovalOnly ? { operatorApprovalOnly: true } : {}),
        session: this.agentSession,
      });
    const requesterAgentId = this.options.requesterAgentId?.trim();
    const loopReply =
      requesterAgentId && requesterAgentId !== this.agentSession.verifiedInference.execution.agentId
        ? await runOutsidePreparedModelRuntimePluginGenerationScope(runTurn)
        : await runTurn();
    if (!loopReply?.text) {
      throw new SystemAgentInferenceUnavailableError("agent-turn");
    }
    this.proposalResolution = undefined;
    if (loopReply.directive) {
      this.clearPendingProposals();
    } else if (this.agentSession.proposalRef.current !== undefined) {
      this.pending = null;
    }
    return await this.applyAgentTurnReply(loopReply);
  }

  private async applyAgentTurnReply(loopReply: {
    text: string;
    directive?: SystemAgentTurnDirective;
  }): Promise<SystemAgentChatReply> {
    await this.requireVerifiedInference();
    const directive = loopReply.directive;
    if (!directive) {
      return { text: loopReply.text, action: "none" };
    }
    const reply =
      directive.kind === "approved-operation"
        ? await this.applyApprovedPersistentOperation(directive.operation)
        : await this.runOperation(directive);
    return {
      ...reply,
      text:
        directive.kind === "open-tui" && reply.action === "open-tui"
          ? loopReply.text
          : [loopReply.text, reply.text].filter(Boolean).join("\n\n"),
    };
  }

  private async runOperation(operation: SystemAgentOperation): Promise<SystemAgentChatReply> {
    const recordedOperation = this.recordCreateAgentRequester(operation);
    await this.requireVerifiedInference();
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
        text: `Opening a chat with your agent. ${this.agentHandoffReturnHint()}`,
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
      return this.startModelSetup();
    }

    const capture = createCaptureRuntime();
    if (isPersistentSystemAgentOperation(recordedOperation) && !this.options.yes) {
      this.clearPendingProposals();
      // Validate through the executor before staging; delegated handoff copy must
      // not turn a forbidden operation into an approvable proposal.
      await executeSystemAgentOperation(recordedOperation, capture, {
        approved: false,
        operatorApprovalOnly: this.options.operatorApprovalOnly,
        deps: this.commandDeps(),
      });
      this.pending = recordedOperation;
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
      return await this.applyApprovedPersistentOperation(recordedOperation);
    }
    const result = await this.executeOperation(recordedOperation, capture);
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
  ): Promise<SystemAgentOperationResult | undefined> {
    try {
      await this.requirePersistentApplyInference(capture);
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
    const verify = result.configWritten ? await this.verifyConfigAfterWrite() : null;
    return [result.text, verify].filter(Boolean).join("\n");
  }

  private async startModelSetup(): Promise<SystemAgentChatReply> {
    this.clearPendingProposals();
    const capture = createCaptureRuntime();
    await executeSystemAgentOperation({ kind: "model-setup" }, capture);
    return { text: capture.read(), action: "none" };
  }

  private commandDeps(): SystemAgentCommandDeps {
    return {
      ...this.options.deps,
      loadOverview: async () => await this.loadOverview(),
      ...(this.options.surface ? { setupSurface: this.options.surface } : {}),
    };
  }

  private agentHandoffReturnHint(): string {
    // Only the TUI uses /openclaw for navigation; web chat runs rescue in place.
    return this.options.surface === "gateway"
      ? "You can return through Settings → Ask OpenClaw."
      : "Use /openclaw to come back.";
  }

  private clearPendingProposals(): void {
    this.pending = null;
    this.agentSession.proposalRef.current = undefined;
    this.agentSession.proposalRef.operation = undefined;
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
