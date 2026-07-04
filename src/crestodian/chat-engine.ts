// Crestodian chat engine: transport-agnostic conversation over typed operations.
import type { RuntimeEnv } from "../runtime.js";
import { WizardSession, type WizardStep } from "../wizard/session.js";
import {
  createCrestodianAgentSession,
  runCrestodianAgentTurn,
  type CrestodianAgentSession,
  type CrestodianAgentTurnRunner,
} from "./agent-turn.js";
import type { CrestodianAssistantPlanner, CrestodianAssistantTurn } from "./assistant.js";
import { approvalQuestion, isYes } from "./dialogue.js";
import {
  describeCrestodianPersistentOperation,
  executeCrestodianOperation,
  isPersistentCrestodianOperation,
  parseCrestodianOperation,
  type CrestodianCommandDeps,
  type CrestodianOperation,
} from "./operations.js";
import { loadCrestodianOverview, type CrestodianOverview } from "./overview.js";

/**
 * One conversation with Crestodian, independent of transport. The TUI backend
 * and the gateway `crestodian.chat` RPC both drive this engine, so onboarding
 * behaves the same in a terminal and in the macOS app.
 *
 * Every free-form message is an AI turn: the custodian persona replies and may
 * propose exactly one typed command. The model never mutates anything — its
 * command re-parses through the same closed operation union, and persistent
 * operations still wait for the user's conversational "yes". Exact typed
 * commands, approvals, and hosted wizards resolve deterministically so the
 * conversation keeps working when no model is usable yet (fresh machine,
 * logged-out CLIs, broken config).
 */
export type CrestodianChatEngineOptions = {
  yes?: boolean;
  deps?: CrestodianCommandDeps;
  planWithAssistant?: CrestodianAssistantPlanner;
  /** Test seam for the embedded agent-loop turn runner. */
  runAgentTurn?: CrestodianAgentTurnRunner;
  /** Where side effects run; the gateway surface never manages its own daemon. */
  surface?: "cli" | "gateway";
  /** Test seam for the channel-setup wizard hosted by the chat bridge. */
  runChannelSetupWizard?: (channel: string, prompter: WizardPrompterLike) => Promise<void>;
};

export type CrestodianChatReplyAction = "none" | "exit" | "open-tui";

export type CrestodianChatReply = {
  text: string;
  action: CrestodianChatReplyAction;
  /** Present when action is "open-tui"; the TUI host executes it. */
  handoff?: CrestodianOperation;
};

type WizardPrompterLike = import("../wizard/prompts.js").WizardPrompter;

type ActiveWizardBridge = {
  session: WizardSession;
  step: WizardStep | null;
  label: string;
  /** Channel to auto-answer in the first selection step ("connect telegram"). */
  autoSelectChannel?: string;
};

type CaptureRuntime = RuntimeEnv & {
  read: () => string;
};

function createCaptureRuntime(): CaptureRuntime {
  const lines: string[] = [];
  return {
    log: (...args) => lines.push(args.join(" ")),
    error: (...args) => lines.push(args.join(" ")),
    exit: (code) => {
      throw new Error(`Crestodian operation exited with code ${String(code)}`);
    },
    read: () => lines.join("\n").trim(),
  };
}

function defaultChannelSetupWizardRunner(
  channel: string,
): (prompter: WizardPrompterLike) => Promise<void> {
  return async (prompter) => {
    const [{ readSetupConfigFileSnapshot, writeWizardConfigFile }, { setupChannels }] =
      await Promise.all([
        import("../wizard/setup.shared.js"),
        import("../commands/onboard-channels.js"),
      ]);
    const snapshot = await readSetupConfigFileSnapshot();
    const baseConfig = snapshot.valid ? (snapshot.sourceConfig ?? snapshot.config) : {};
    const { defaultRuntime } = await import("../runtime.js");
    const nextConfig = await setupChannels(baseConfig, defaultRuntime, prompter, {
      initialSelection: [channel],
      forceAllowFromChannels: [channel],
      allowSignalInstall: true,
      deferStatusUntilSelection: true,
      quickstartDefaults: true,
      skipDmPolicyPrompt: true,
      skipConfirm: true,
    });
    await writeWizardConfigFile(nextConfig, { allowConfigSizeDrop: false });
  };
}

function formatWizardOptions(step: WizardStep): string[] {
  return (step.options ?? []).map((option, index) => {
    const hint = option.hint ? ` — ${option.hint}` : "";
    return `${index + 1}. ${option.label}${hint}`;
  });
}

function renderWizardStep(step: WizardStep): string {
  const lines: string[] = [];
  if (step.title) {
    lines.push(`**${step.title}**`);
  }
  if (step.message) {
    lines.push(step.message);
  }
  switch (step.type) {
    case "select":
      lines.push(...formatWizardOptions(step), "Reply with a number.");
      break;
    case "multiselect":
      lines.push(...formatWizardOptions(step), "Reply with numbers (e.g. 1,3) or `none`.");
      break;
    case "confirm":
      lines.push("Reply yes or no.");
      break;
    case "text":
      if (step.placeholder) {
        lines.push(`(e.g. ${step.placeholder})`);
      }
      lines.push("Type your answer.");
      break;
    default:
      break;
  }
  lines.push("Say `cancel` to stop this setup.");
  return lines.filter(Boolean).join("\n");
}

/** Map a chat reply to a wizard step answer; null means "could not parse". */
function parseWizardAnswer(step: WizardStep, text: string): { value: unknown } | null {
  const trimmed = text.trim();
  if (step.type === "confirm") {
    if (isYes(trimmed)) {
      return { value: true };
    }
    if (/^(n|no|nope|skip)$/i.test(trimmed)) {
      return { value: false };
    }
    return null;
  }
  if (step.type === "text") {
    return { value: trimmed };
  }
  const options = step.options ?? [];
  const matchOption = (token: string) => {
    const index = Number(token);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      return options[index - 1];
    }
    const lower = token.toLowerCase();
    return options.find(
      (option) =>
        option.label.toLowerCase() === lower ||
        (typeof option.value === "string" && option.value.toLowerCase() === lower),
    );
  };
  if (step.type === "select") {
    const option = matchOption(trimmed);
    return option ? { value: option.value } : null;
  }
  if (step.type === "multiselect") {
    if (/^none$/i.test(trimmed)) {
      return { value: [] };
    }
    const tokens = trimmed
      .split(/[\s,]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    const values: unknown[] = [];
    for (const token of tokens) {
      const option = matchOption(token);
      if (!option) {
        return null;
      }
      values.push(option.value);
    }
    return { value: values };
  }
  // note/progress/action steps advance on any input.
  return { value: step.type === "action" ? true : undefined };
}

const DECLINE_RE = /^(n|no|nope|skip|not now|cancel|later)\b/i;

function formatOperationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `That did not go through: ${message}`;
}

/**
 * Hard ceiling for one AI turn. Planner backends carry their own timeouts,
 * but a wedged local CLI (heavy user config, hung app-server) must never
 * freeze the conversation — after this we answer deterministically.
 */
const ASSISTANT_TURN_DEADLINE_MS = 60_000;
// Agent-loop turns include tool calls (config writes, doctor); allow longer.
const AGENT_TURN_DEADLINE_MS = 180_000;

async function withDeadline<T>(work: Promise<T>, fallback: T, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), deadlineMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export class CrestodianChatEngine {
  private pending: CrestodianOperation | null = null;
  private wizardBridge: ActiveWizardBridge | null = null;
  private readonly history: CrestodianAssistantTurn[] = [];
  private readonly agentSession: CrestodianAgentSession = createCrestodianAgentSession();

  constructor(private readonly opts: CrestodianChatEngineOptions = {}) {}

  /**
   * Seed a proposed operation that a bare "yes" will apply. Used by first-run
   * onboarding: the welcome message states the plan, the user just agrees.
   */
  propose(operation: CrestodianOperation): string {
    this.pending = operation;
    return describeCrestodianPersistentOperation(operation);
  }

  hasPendingProposal(): boolean {
    return this.pending !== null;
  }

  /** Record a host-rendered assistant message (welcome) so AI turns see it. */
  noteAssistantMessage(text: string): void {
    this.history.push({ role: "assistant", text });
  }

  async handle(text: string): Promise<CrestodianChatReply> {
    const reply = await this.resolveTurn(text);
    this.history.push({ role: "user", text });
    if (reply.text) {
      this.history.push({ role: "assistant", text: reply.text });
    }
    return reply;
  }

  private async resolveTurn(text: string): Promise<CrestodianChatReply> {
    if (this.wizardBridge) {
      // A hosted wizard consumes every reply until it finishes or is cancelled.
      return { text: await this.resolveWizardBridgeReply(text), action: "none" };
    }
    if (this.pending) {
      // Approval is deterministic: "yes" applies, a clear "no" drops the
      // proposal. Anything else goes to the AI with the proposal kept pending,
      // so questions ("what's a workspace?") don't silently cancel setup.
      if (isYes(text)) {
        const pending = this.pending;
        this.pending = null;
        if (pending.kind === "channel-setup") {
          return { text: await this.startChannelSetupWizard(pending.channel), action: "none" };
        }
        const capture = createCaptureRuntime();
        let applied = false;
        try {
          const result = await executeCrestodianOperation(pending, capture, {
            approved: true,
            deps: this.commandDeps(),
          });
          applied = result.applied;
        } catch (error) {
          capture.error(formatOperationError(error));
        }
        const verify = applied ? await this.verifyConfigAfterWrite() : null;
        return {
          text: [capture.read() || "Applied. Audit entry written.", verify]
            .filter(Boolean)
            .join("\n\n"),
          action: "none",
        };
      }
      if (DECLINE_RE.test(text.trim())) {
        this.pending = null;
        return { text: "Skipped. No barnacles on config today.", action: "none" };
      }
    }

    // Exact typed commands run deterministically (instant, no model); strict
    // grammar keeps anything conversational flowing to the AI custodian.
    const direct = parseCrestodianOperation(text, { strict: true });
    if (direct.kind !== "none") {
      return await this.runOperation(direct, undefined);
    }
    if (!text.trim()) {
      return { text: direct.message, action: "none" };
    }
    if (/^(quit|exit)$/i.test(text.trim())) {
      return { text: "Crestodian retracts into shell. Bye.", action: "exit" };
    }

    return await this.resolveAssistantTurn(text);
  }

  /**
   * AI turn: the custodian persona answers and may propose one typed command.
   * Falls back to deterministic guidance when no model backend is usable.
   */
  private async resolveAssistantTurn(text: string): Promise<CrestodianChatReply> {
    const overview = await this.loadOverview();

    // Preferred path: the real agent loop (embedded runtime, ring-zero tool,
    // persistent session). It acts through audited tool calls, so its reply is
    // final — no engine-side command extraction or approval bookkeeping.
    const agentTurn = this.opts.runAgentTurn ?? runCrestodianAgentTurn;
    try {
      const loopReply = await withDeadline(
        agentTurn({
          input: text,
          overview,
          surface: this.opts.surface ?? "cli",
          // Mutations unlock only on an explicit user approval in this exact
          // message; the model cannot self-approve (see crestodian-tool.ts).
          approvalArmed: isYes(text),
          session: this.agentSession,
        }).catch(() => null),
        null,
        AGENT_TURN_DEADLINE_MS,
      );
      if (loopReply?.text) {
        return { text: loopReply.text, action: "none" };
      }
    } catch {
      // Fall through to the single-turn planner.
    }

    const planner =
      this.opts.planWithAssistant ?? (await import("./assistant.js")).planCrestodianCommand;
    let plan: Awaited<ReturnType<CrestodianAssistantPlanner>> = null;
    try {
      plan = await withDeadline(
        planner({
          input: text,
          overview,
          history: this.history,
          ...(this.pending
            ? { pendingOperation: describeCrestodianPersistentOperation(this.pending) }
            : {}),
        }).catch(() => null),
        null,
        ASSISTANT_TURN_DEADLINE_MS,
      );
    } catch {
      plan = null;
    }
    if (!plan) {
      return {
        text: [
          "I could not reach a model for that (deterministic mode).",
          "I can run doctor/status/health, check or restart Gateway, list agents/models, set default model, connect channels (`connect telegram`), show audit, or switch to your agent TUI.",
        ].join("\n"),
        action: "none",
      };
    }

    const replyText = plan.reply ?? "";
    if (!plan.command) {
      return { text: replyText || "…", action: "none" };
    }
    const operation = parseCrestodianOperation(plan.command);
    if (operation.kind === "none") {
      // The model suggested something outside the vocabulary; show only its reply.
      return { text: replyText || "…", action: "none" };
    }
    // Security contract: surface the interpreted command and model before
    // anything runs (docs/cli/crestodian.md, Model-Assisted Planner).
    const provenance = `(${plan.modelLabel ?? "model"} → \`${plan.command}\`)`;
    const executed = await this.runOperation(operation, provenance);
    return {
      ...executed,
      text: [replyText, executed.text].filter(Boolean).join("\n\n"),
    };
  }

  private async runOperation(
    operation: CrestodianOperation,
    provenance: string | undefined,
  ): Promise<CrestodianChatReply> {
    if (operation.kind === "open-tui") {
      return {
        text: "Opening your normal agent TUI. Use /crestodian there to come back.",
        action: "open-tui",
        handoff: operation,
      };
    }

    if (operation.kind === "channel-setup" && this.opts.yes) {
      return { text: await this.startChannelSetupWizard(operation.channel), action: "none" };
    }

    const capture = createCaptureRuntime();
    if (isPersistentCrestodianOperation(operation) && !this.opts.yes) {
      this.pending = operation;
      await executeCrestodianOperation(operation, capture, {
        approved: false,
        deps: this.commandDeps(),
      });
      return {
        text: [provenance, capture.read(), approvalQuestion(operation)]
          .filter(Boolean)
          .join("\n\n"),
        action: "none",
      };
    }

    let applied = false;
    try {
      const result = await executeCrestodianOperation(operation, capture, {
        approved: this.opts.yes === true || !isPersistentCrestodianOperation(operation),
        deps: this.commandDeps(),
      });
      applied = result.applied;
    } catch (error) {
      capture.error(formatOperationError(error));
    }
    const verify = applied ? await this.verifyConfigAfterWrite() : null;
    const reply = [provenance, capture.read(), verify].filter(Boolean).join("\n\n");
    if (operation.kind === "none" && reply.includes("Bye.")) {
      return { text: reply, action: "exit" };
    }
    return { text: reply, action: "none" };
  }

  async loadOverview(): Promise<CrestodianOverview> {
    if (this.opts.deps?.loadOverview) {
      return await this.opts.deps.loadOverview();
    }
    return await loadCrestodianOverview();
  }

  /**
   * Post-write hook: re-validate openclaw.json after every applied operation.
   * On failure the exact schema issues go straight back into the conversation
   * (and to the AI, which proposes one corrective command) so a bad write is
   * caught and fixed in the same chat instead of surfacing at gateway start.
   */
  private async verifyConfigAfterWrite(): Promise<string | null> {
    let issuesText: string | null = null;
    try {
      const { readConfigFileSnapshot } = await import("../config/config.js");
      const snapshot = await readConfigFileSnapshot();
      if (!snapshot.exists || snapshot.valid) {
        return null;
      }
      const issues = (snapshot.issues ?? []).map(
        (issue: { path?: string; message: string }) =>
          `${issue.path ? `${issue.path}: ` : ""}${issue.message}`,
      );
      issuesText = issues.length > 0 ? issues.join("\n") : "unknown validation failure";
    } catch {
      return null;
    }
    const notice = `⚠ openclaw.json failed validation after that write:\n${issuesText}`;
    const recovery = await this.resolveAssistantTurn(
      `[config-verify] The config file is now invalid:\n${issuesText}\nPropose one corrective command from the allowed list.`,
    );
    if (!recovery.text || recovery.text.includes("deterministic mode")) {
      return `${notice}\nSay \`doctor fix\` to repair it, or \`config schema <path>\` to check the expected shape.`;
    }
    return `${notice}\n\n${recovery.text}`;
  }

  private commandDeps(): CrestodianCommandDeps | undefined {
    if (!this.opts.deps && !this.opts.surface) {
      return undefined;
    }
    return {
      ...this.opts.deps,
      ...(this.opts.surface ? { setupSurface: this.opts.surface } : {}),
    };
  }

  private async startChannelSetupWizard(channel: string): Promise<string> {
    const runWizard =
      this.opts.runChannelSetupWizard ??
      ((ch: string, prompter: WizardPrompterLike) => defaultChannelSetupWizardRunner(ch)(prompter));
    const session = new WizardSession((prompter) => runWizard(channel, prompter));
    this.wizardBridge = { session, step: null, label: channel, autoSelectChannel: channel };
    return await this.pumpWizardBridge();
  }

  /**
   * "connect telegram" already names the channel; answer the wizard's channel
   * selection step automatically instead of echoing the full channel wall.
   */
  private tryAutoSelectChannel(step: WizardStep): { value: unknown } | null {
    const bridge = this.wizardBridge;
    const channel = bridge?.autoSelectChannel;
    if (!bridge || !channel) {
      return null;
    }
    if (step.type !== "select" && step.type !== "multiselect") {
      return null;
    }
    const match = (step.options ?? []).find(
      (option) => typeof option.value === "string" && option.value.toLowerCase() === channel,
    );
    if (!match) {
      return null;
    }
    bridge.autoSelectChannel = undefined;
    return { value: step.type === "multiselect" ? [match.value] : match.value };
  }

  /** Advance the hosted wizard to the next interactive step (or completion). */
  private async pumpWizardBridge(): Promise<string> {
    const bridge = this.wizardBridge;
    if (!bridge) {
      return "";
    }
    const result = await bridge.session.next();
    if (result.done) {
      this.wizardBridge = null;
      const label = bridge.label;
      if (result.status === "done") {
        const { appendCrestodianAuditEntry } = await import("./audit.js");
        await appendCrestodianAuditEntry({
          operation: "channels.setup",
          summary: `Configured channel ${label} via chat setup`,
          details: { channel: label },
        });
        const verify = await this.verifyConfigAfterWrite();
        return [
          `Done — ${label} is configured.`,
          "Say `restart gateway` to apply channel changes, or `channels` to review.",
          verify ?? "",
        ]
          .filter(Boolean)
          .join("\n");
      }
      if (result.status === "cancelled") {
        return "Channel setup cancelled. Nothing was changed beyond completed steps.";
      }
      return `Channel setup stopped: ${result.error ?? "unknown error"}`;
    }
    bridge.step = result.step ?? null;
    if (bridge.step) {
      const auto = this.tryAutoSelectChannel(bridge.step);
      if (auto) {
        const step = bridge.step;
        bridge.step = null;
        await bridge.session.answer(step.id, auto.value);
        return await this.pumpWizardBridge();
      }
    }
    return bridge.step ? renderWizardStep(bridge.step) : "";
  }

  private async resolveWizardBridgeReply(text: string): Promise<string> {
    const bridge = this.wizardBridge;
    if (!bridge) {
      return "";
    }
    if (/^(cancel|abort|stop|quit|exit)$/i.test(text.trim())) {
      bridge.session.cancel();
      return await this.pumpWizardBridge();
    }
    const step = bridge.step;
    if (!step) {
      return await this.pumpWizardBridge();
    }
    const answer = parseWizardAnswer(step, text);
    if (!answer) {
      return ["I could not match that answer.", renderWizardStep(step)].join("\n");
    }
    await bridge.session.answer(step.id, answer.value);
    return await this.pumpWizardBridge();
  }
}
