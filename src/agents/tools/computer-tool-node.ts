import crypto from "node:crypto";
import { imageMimeFromFormat } from "@openclaw/media-core/mime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  ComputerActParams,
  ComputerActResult,
  ComputerUseCapabilityDescriptor,
  ComputerUseV2ActionName,
  ScreenSnapshotParams,
} from "../../plugins/computer-use-contract.js";
import {
  COMPUTER_CONTRACT_MISMATCH,
  COMPUTER_STALE_OBSERVATION,
  parseComputerActResult,
  parseScreenSnapshotResult,
} from "../../plugins/computer-use-contract.js";
import {
  NOT_COMPUTER_CAPABLE_HINT,
  resolveComputerBinding,
  type ComputerBinding,
} from "./computer-tool-bindings.js";
import type { GatewayComputerStatus } from "./computer-tool-gateway.js";
import { computerActionNeedsFrame, validateCapabilityBoundInput } from "./computer-tool-request.js";
import type {
  ComputerContextEpoch,
  ComputerFrame,
  ComputerObservationState,
  ComputerTarget,
  ComputerToolAction,
  ComputerToolTransport,
  ResolvedComputerTarget,
  ScreenshotCapture,
} from "./computer-tool-shared.js";
import {
  COMPUTER_ACT_COMMAND,
  computerHostKey,
  SCREENSHOT_QUALITY,
  SCREEN_SNAPSHOT_COMMAND,
} from "./computer-tool-shared.js";
import type { GatewayCallOptions } from "./gateway.js";

type ComputerState =
  | { kind: "unbound" }
  | { kind: "target"; target: ComputerTarget }
  | ({ kind: "frame" } & ComputerFrame);

const DANGEROUS_DENY_HINT = "blocked by gateway.nodes.commands.deny";
const PLATFORM_ALLOWLIST_HINT = "is not in the allowlist for platform";
const BUTTON_NOT_HELD_HINT = "left button is not held by computer control";
const DEFINITIVE_NODE_COMMAND_REASONS = new Set([
  "command required",
  "command not allowlisted",
  "command not declared by node",
  "node did not declare commands",
]);

function parseComputerActPayload(value: unknown): ComputerActResult {
  if (typeof value !== "string") {
    return parseComputerActResult(value);
  }
  try {
    return parseComputerActResult(JSON.parse(value));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(COMPUTER_CONTRACT_MISMATCH)) {
      throw error;
    }
    throw new Error(`${COMPUTER_CONTRACT_MISMATCH}: computer.act returned invalid JSON`, {
      cause: error,
    });
  }
}

function computerActIdempotencyKey(params: {
  scope?: string;
  toolCallId: string;
  purpose?: "follow-up-observation";
}): string {
  const stableScope = params.scope?.trim();
  const stableCallId = params.toolCallId.trim();
  if (!stableScope || !stableCallId) {
    // A call id is only unique inside its model response. Without a stable run
    // scope and provider/fallback id, avoid collapsing unrelated actions.
    return crypto.randomUUID();
  }
  const parts = [stableScope, stableCallId, COMPUTER_ACT_COMMAND];
  if (params.purpose) {
    parts.push(params.purpose);
  }
  const digest = crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  // The automatic read shares a tool-call id with input, but must never replay its result.
  if (params.purpose) {
    return `computer.observation:v1:${digest}`;
  }
  // `v1` versions this key's composition (scope + call id + command), not the
  // `computer.act` wire contract. Changing what goes into the digest needs a
  // new prefix so in-flight keys from an older node cannot collide.
  return `computer.act:v1:${digest}`;
}

function gatewayRequestDetails(err: unknown): Record<string, unknown> | undefined {
  if (!(err instanceof Error) || err.name !== "GatewayClientRequestError") {
    return undefined;
  }
  const details = (err as Error & { details?: unknown }).details;
  return isRecord(details) ? details : undefined;
}

function withComputerEnablementHint(err: unknown): Error {
  const message = formatErrorMessage(err);
  const reason = gatewayRequestDetails(err)?.reason;
  if (message.includes(DANGEROUS_DENY_HINT)) {
    return new Error(
      `${message} — remove ${COMPUTER_ACT_COMMAND} from gateway.nodes.commands.deny, then retry.`,
      { cause: err },
    );
  }
  if (
    reason === "command not allowlisted" ||
    reason === "command not declared by node" ||
    reason === "node did not declare commands" ||
    message.includes(PLATFORM_ALLOWLIST_HINT)
  ) {
    return new Error(`${message} — ${NOT_COMPUTER_CAPABLE_HINT}, then retry.`, { cause: err });
  }
  return err instanceof Error ? err : new Error(message);
}

function isDefinitiveComputerActRejection(err: unknown): boolean {
  const details = gatewayRequestDetails(err);
  return (
    details?.nodeCommandDispatched === false ||
    (typeof details?.reason === "string" && DEFINITIVE_NODE_COMMAND_REASONS.has(details.reason))
  );
}

function isButtonAlreadyReleasedError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === "GatewayClientRequestError" &&
    err.message.includes(BUTTON_NOT_HELD_HINT)
  );
}

export class ComputerToolSession {
  private selectedCapabilities: ComputerUseCapabilityDescriptor | undefined;
  private selectedCapabilityTargetKey: string | undefined;
  private observationState: ComputerObservationState | undefined;
  private computerState: ComputerState = { kind: "unbound" };
  private heldButtonTarget: ComputerTarget | undefined;
  private readonly executionTargets = new Map<string, ComputerBinding>();
  private readonly retiredGatewayBindings = new Set<ComputerBinding>();
  private disposePromise: Promise<void> | undefined;

  constructor(
    private readonly options: {
      executionId: string;
      idempotencyScope?: string;
      contextEpoch?: ComputerContextEpoch;
      transport?: ComputerToolTransport;
      gatewayStatus?: GatewayComputerStatus;
      availableActions: (
        actions: readonly ComputerUseV2ActionName[],
      ) => readonly ComputerUseV2ActionName[];
      defaultActions: readonly ComputerUseV2ActionName[];
      onCapabilitiesChanged: (capabilities?: ComputerUseCapabilityDescriptor) => void;
      registerRunCleanup?: (cleanup: (reason: string) => Promise<void>) => void;
      getOperationQueue: () => Promise<unknown>;
    },
  ) {
    options.registerRunCleanup?.((reason) => this.dispose(reason));
  }

  private assertOpen(): void {
    if (this.disposePromise) {
      throw new Error("computer: execution is closed");
    }
  }

  private bindCapabilities(binding: ComputerBinding, refresh = false): void {
    const next = binding.capabilities;
    const targetKey = computerHostKey(binding.host);
    const changed =
      this.selectedCapabilityTargetKey !== targetKey ||
      this.selectedCapabilities?.provider.generation !== next?.provider.generation;
    this.selectedCapabilityTargetKey = targetKey;
    this.selectedCapabilities = next;
    if (changed || refresh) {
      this.options.onCapabilitiesChanged(next);
    }
    if (changed) {
      this.observationState = undefined;
    }
  }

  private setComputerState(next: ComputerState): void {
    this.computerState = next;
    if (!this.options.contextEpoch) {
      return;
    }
    if (next.kind !== "frame") {
      delete this.options.contextEpoch.frameToolCallId;
      delete this.options.contextEpoch.frameImageIdentity;
    }
  }

  setTarget(target: ComputerTarget): void {
    this.setComputerState({ kind: "target", target });
  }

  private prepareScreenshotTarget(target: ComputerTarget): void {
    const frame = this.computerState;
    const contextEpoch = this.options.contextEpoch;
    // Retain the visible frame only until replacement pixels are verified; failures clear it.
    if (
      contextEpoch?.frameImageIdentity &&
      frame.kind === "frame" &&
      computerHostKey(frame.target) === computerHostKey(target) &&
      frame.target.screenIndex === target.screenIndex &&
      frame.contextEpoch === contextEpoch.value
    ) {
      return;
    }
    this.setTarget(target);
  }

  refreshUnchangedFrame(params: {
    target: ComputerTarget;
    capture: ScreenshotCapture;
    imageIdentity?: string;
    modelHasVision?: boolean;
  }): ComputerFrame | undefined {
    const frame = this.computerState;
    const contextEpoch = this.options.contextEpoch;
    // Without context tracking, the earlier screenshot may already have been pruned.
    if (
      params.modelHasVision === false ||
      !contextEpoch?.frameImageIdentity ||
      contextEpoch.frameImageIdentity !== params.imageIdentity ||
      frame.kind !== "frame" ||
      computerHostKey(frame.target) !== computerHostKey(params.target) ||
      frame.target.screenIndex !== params.target.screenIndex ||
      frame.contextEpoch !== contextEpoch.value
    ) {
      return undefined;
    }
    // Keep the model's original image/frame binding while refreshing the node's capture token.
    frame.displayFrameId = params.capture.displayFrameId;
    return frame;
  }

  bindDeliveredFrame(params: {
    resolved: ResolvedComputerTarget;
    capture: ScreenshotCapture;
    frameId: string;
    toolCallId: string;
    imageIdentity?: string;
    modelHasVision?: boolean;
  }): void {
    if (params.modelHasVision === false || !params.imageIdentity) {
      this.setTarget(params.resolved.target);
      return;
    }
    this.computerState = {
      kind: "frame",
      target: params.resolved.target,
      id: params.frameId,
      displayFrameId: params.capture.displayFrameId,
      contextEpoch: this.options.contextEpoch?.value ?? 0,
    };
    if (this.options.contextEpoch) {
      this.options.contextEpoch.frameToolCallId = params.toolCallId;
      this.options.contextEpoch.frameImageIdentity = params.imageIdentity;
    }
  }

  recordObservation(
    resolved: ResolvedComputerTarget,
    result: ComputerActResult,
    imageCoordinates?: ComputerObservationState["imageCoordinates"],
  ): void {
    const observationId = result.observation?.observationId;
    if (observationId && resolved.capabilities) {
      this.observationState = {
        targetKey: computerHostKey(resolved.target),
        providerGeneration: resolved.capabilities.provider.generation,
        observationId,
        imageCoordinates,
      };
    }
  }

  async resolveTarget(params: {
    action: ComputerToolAction;
    input: Record<string, unknown>;
    gatewayOpts: GatewayCallOptions;
    signal?: AbortSignal;
  }): Promise<ResolvedComputerTarget> {
    this.assertOpen();
    const explicitHost = params.input.target;
    if (explicitHost !== undefined && explicitHost !== "gateway" && explicitHost !== "node") {
      throw new Error("computer target must be gateway or node");
    }
    const explicitNode = typeof params.input.node === "string" ? params.input.node : undefined;
    const environmentId =
      typeof params.input.environmentId === "string"
        ? params.input.environmentId.trim()
        : undefined;
    if (
      environmentId !== undefined &&
      (!environmentId ||
        explicitHost !== undefined ||
        explicitNode !== undefined ||
        params.gatewayOpts.gatewayUrl ||
        params.gatewayOpts.gatewayToken ||
        this.options.transport)
    ) {
      throw new Error(
        "Computer environmentId must select an attached environment without another target or Gateway override",
      );
    }
    if (explicitHost === "gateway" && explicitNode !== undefined) {
      throw new Error("computer target=gateway does not accept a node selector");
    }
    if (
      this.options.transport &&
      (explicitHost !== undefined ||
        params.gatewayOpts.gatewayUrl ||
        params.gatewayOpts.gatewayToken)
    ) {
      throw new Error("Computer control is bound to this session's desktop");
    }
    const explicitScreenIndex = (() => {
      if (params.input.screenIndex === undefined) {
        return undefined;
      }
      if (
        typeof params.input.screenIndex !== "number" ||
        !Number.isInteger(params.input.screenIndex) ||
        params.input.screenIndex < 0
      ) {
        throw new Error("screenIndex must be a non-negative integer");
      }
      return params.input.screenIndex;
    })();
    const needsFrame = computerActionNeedsFrame(params.action, params.input);
    const priorTarget =
      this.computerState.kind === "unbound" ? undefined : this.computerState.target;
    const implicitTarget = this.heldButtonTarget ?? priorTarget;
    const reuseTarget =
      explicitNode === undefined &&
      implicitTarget &&
      (environmentId === undefined ||
        (implicitTarget.host === "node" && implicitTarget.environmentId === environmentId)) &&
      (explicitHost === undefined || explicitHost === implicitTarget.host);
    const explicitGateway =
      params.gatewayOpts.gatewayUrl !== undefined || params.gatewayOpts.gatewayToken !== undefined;
    const priorBinding = priorTarget
      ? this.executionTargets.get(computerHostKey(priorTarget))
      : undefined;
    const selectionGatewayOpts =
      explicitNode !== undefined && !explicitGateway && priorBinding?.host.host === "node"
        ? {
            ...priorBinding.gatewayOpts,
            timeoutMs: params.gatewayOpts.timeoutMs ?? priorBinding.gatewayOpts.timeoutMs,
          }
        : params.gatewayOpts;
    const resolvedBinding = reuseTarget
      ? this.executionTargets.get(computerHostKey(implicitTarget))!
      : await resolveComputerBinding({
          executionId: this.options.executionId,
          sessionTransport: this.options.transport,
          gatewayStatus: this.options.gatewayStatus,
          target: explicitHost,
          node: explicitNode,
          environmentId,
          gatewayOpts: selectionGatewayOpts,
          signal: params.signal,
        });
    this.assertOpen();
    const targetKey = computerHostKey(resolvedBinding.host);
    const existingBinding = this.executionTargets.get(targetKey);
    const refreshNode =
      explicitNode !== undefined && !this.options.transport && resolvedBinding.host.host === "node";
    const nextGatewayOpts = refreshNode ? resolvedBinding.gatewayOpts : params.gatewayOpts;
    if (
      existingBinding &&
      (explicitGateway || refreshNode) &&
      (nextGatewayOpts.gatewayUrl !== existingBinding.gatewayOpts.gatewayUrl ||
        nextGatewayOpts.gatewayToken !== existingBinding.gatewayOpts.gatewayToken)
    ) {
      throw new Error(
        "Computer target is bound to its Gateway connection; start a new execution to change it",
      );
    }
    const binding = refreshNode ? resolvedBinding : (existingBinding ?? resolvedBinding);
    const capabilities = binding.capabilities;
    this.bindCapabilities(binding, refreshNode);
    this.executionTargets.set(targetKey, binding);
    const advertisedActions = this.options.availableActions(
      capabilities?.actions ?? this.options.defaultActions,
    );
    if (!advertisedActions.includes(params.action)) {
      throw new Error(
        `${COMPUTER_CONTRACT_MISMATCH}: computer ${targetKey} does not advertise action ${params.action}`,
      );
    }
    validateCapabilityBoundInput({
      action: params.action,
      input: params.input,
      targetKey,
      capabilities,
      observationState: this.observationState,
    });
    if (this.heldButtonTarget && targetKey !== computerHostKey(this.heldButtonTarget)) {
      const heldHost =
        this.heldButtonTarget.host === "gateway"
          ? "Gateway"
          : `node ${this.heldButtonTarget.nodeId}`;
      throw new Error(
        `computer: left button may still be held on ${heldHost}; ` +
          "release it before targeting another computer",
      );
    }
    if (
      this.heldButtonTarget &&
      explicitScreenIndex !== undefined &&
      explicitScreenIndex !== this.heldButtonTarget.screenIndex
    ) {
      throw new Error(
        `computer: left button may still be held on screen ${this.heldButtonTarget.screenIndex}; ` +
          "release it before targeting another screen",
      );
    }
    const targetForHost =
      priorTarget && computerHostKey(priorTarget) === targetKey ? priorTarget : undefined;
    const frame =
      this.computerState.kind === "frame" &&
      computerHostKey(this.computerState.target) === targetKey &&
      this.computerState.contextEpoch === (this.options.contextEpoch?.value ?? 0)
        ? this.computerState
        : undefined;
    if (needsFrame && !frame) {
      throw new Error(
        "computer: no screenshot of this computer has been taken yet, so there is no display frame to " +
          "target. Take a `screenshot` first (of this computer) before issuing coordinate actions.",
      );
    }
    if (
      needsFrame &&
      explicitScreenIndex !== undefined &&
      explicitScreenIndex !== frame?.target.screenIndex
    ) {
      throw new Error("computer: screenIndex does not match the most recent screenshot frame");
    }
    if (needsFrame && params.input.frameId !== frame?.id) {
      throw new Error(
        "computer: frameId does not match the most recent screenshot result; take a new screenshot",
      );
    }
    const screenIndex =
      explicitScreenIndex ??
      frame?.target.screenIndex ??
      this.heldButtonTarget?.screenIndex ??
      targetForHost?.screenIndex ??
      0;
    return { target: { ...binding.host, screenIndex }, frame, capabilities };
  }

  async captureScreenshot(
    resolved: ResolvedComputerTarget,
    refWidth: number,
    signal?: AbortSignal,
  ): Promise<ScreenshotCapture> {
    this.assertOpen();
    this.prepareScreenshotTarget(resolved.target);
    const commandParams: ScreenSnapshotParams = {
      executionId: this.options.executionId,
      screenIndex: resolved.target.screenIndex,
      maxWidth: refWidth,
      quality: SCREENSHOT_QUALITY,
      format: "jpeg",
    };
    try {
      const capture = (binding: ComputerBinding) =>
        binding.invoke({
          command: SCREEN_SNAPSHOT_COMMAND,
          commandParams,
          signal,
        });
      const targetKey = computerHostKey(resolved.target);
      const binding = this.executionTargets.get(targetKey)!;
      let payload: unknown;
      try {
        payload = await capture(binding);
      } catch (error) {
        if (
          binding.host.host !== "gateway" ||
          !(error instanceof Error) ||
          !/^(?:Error: )?COMPUTER_STALE_OBSERVATION:/.test(error.message)
        ) {
          throw error;
        }
        // Only a fresh screen read can reopen the same Gateway after native retirement.
        this.setTarget(resolved.target);
        this.observationState = undefined;
        this.assertOpen();
        signal?.throwIfAborted();
        const refreshed = await resolveComputerBinding({
          executionId: this.options.executionId,
          target: "gateway",
          gatewayOpts: binding.gatewayOpts,
          signal,
        });
        this.retiredGatewayBindings.add(binding);
        this.executionTargets.set(targetKey, refreshed);
        this.assertOpen();
        signal?.throwIfAborted();
        this.bindCapabilities(refreshed);
        if (
          binding.capabilities?.provider.generation !== refreshed.capabilities?.provider.generation
        ) {
          this.heldButtonTarget = undefined;
        }
        payload = await capture(refreshed);
      }
      const parsed = parseScreenSnapshotResult(payload);
      if (!parsed.displayFrameId) {
        throw new Error(
          "screen.snapshot response missing displayFrameId; update the computer provider before computer use",
        );
      }
      return {
        base64: parsed.base64,
        displayFrameId: parsed.displayFrameId,
        mimeType: imageMimeFromFormat(parsed.format) ?? "image/jpeg",
        width: parsed.width,
        height: parsed.height,
      };
    } catch (error) {
      this.setTarget(resolved.target);
      throw error;
    }
  }

  async invokeComputerAct(params: {
    resolved: ResolvedComputerTarget;
    wireParams: ComputerActParams;
    toolCallId: string;
    purpose?: "follow-up-observation";
    signal?: AbortSignal;
  }): Promise<ComputerActResult> {
    this.assertOpen();
    const durationMs =
      "durationMs" in params.wireParams && typeof params.wireParams.durationMs === "number"
        ? params.wireParams.durationMs
        : undefined;
    const invokeTimeoutMs = durationMs ? durationMs + 10_000 : undefined;
    params.signal?.throwIfAborted();
    const commandParams: Record<string, unknown> = { ...params.wireParams };
    const imageCoordinates =
      commandParams.windowRef &&
      commandParams.observationId === this.observationState?.observationId
        ? this.observationState?.imageCoordinates
        : undefined;
    if (imageCoordinates) {
      // Map only the image bound to this validated observation. Browser CSS requests
      // have no windowRef; native coordinate spaces and element refs remain unchanged.
      for (const [x, y] of [
        ["x", "y"],
        ["fromX", "fromY"],
        ["x1", "y1"],
        ["x2", "y2"],
      ] as const) {
        if (typeof commandParams[x] === "number" && typeof commandParams[y] === "number") {
          if (imageCoordinates.kind === "unavailable") {
            throw new Error(
              `${COMPUTER_STALE_OBSERVATION}: take a fresh image observation and retry`,
            );
          }
          commandParams[x] *= imageCoordinates.scaleX;
          commandParams[y] *= imageCoordinates.scaleY;
        }
      }
    }
    this.prepareScreenshotTarget(params.resolved.target);
    if (params.purpose === "follow-up-observation") {
      // Input may have changed the window. A failed refresh must not leave its old refs usable.
      this.observationState = undefined;
    }
    if (params.wireParams.action === "left_mouse_down") {
      this.heldButtonTarget = params.resolved.target;
    }
    let actResult: ComputerActResult;
    try {
      actResult = parseComputerActPayload(
        await this.executionTargets.get(computerHostKey(params.resolved.target))!.invoke({
          command: COMPUTER_ACT_COMMAND,
          commandParams,
          timeoutMs: invokeTimeoutMs,
          idempotencyKey: computerActIdempotencyKey({
            scope: this.options.idempotencyScope,
            toolCallId: params.toolCallId,
            purpose: params.purpose,
          }),
          signal: params.signal,
        }),
      );
    } catch (err) {
      if (params.wireParams.action === "left_mouse_down" && isDefinitiveComputerActRejection(err)) {
        this.heldButtonTarget = undefined;
      }
      if (params.wireParams.action === "left_mouse_up" && isButtonAlreadyReleasedError(err)) {
        this.heldButtonTarget = undefined;
        actResult = { ok: true };
      } else {
        this.setTarget(params.resolved.target);
        throw withComputerEnablementHint(err);
      }
    }
    if (params.wireParams.action === "left_mouse_up") {
      this.heldButtonTarget = undefined;
    }
    return actResult;
  }

  async dispose(reason: string): Promise<void> {
    if (this.disposePromise) {
      return await this.disposePromise;
    }
    this.disposePromise = this.options
      .getOperationQueue()
      .catch(() => {})
      .then(async () => {
        const targets = [
          ...this.executionTargets.entries(),
          ...[...this.retiredGatewayBindings].map((binding): [string, ComputerBinding] => [
            computerHostKey(binding.host),
            binding,
          ]),
        ];
        this.executionTargets.clear();
        this.retiredGatewayBindings.clear();
        const results = await Promise.allSettled(
          targets.map(async ([targetKey, binding]) => {
            await binding.invoke({
              command: COMPUTER_ACT_COMMAND,
              commandParams: {
                action: "__close_execution",
                executionId: this.options.executionId,
                reason,
              },
              idempotencyKey: `computer.close:${this.options.executionId}:${targetKey}`,
            });
          }),
        );
        // Ordinary paired nodes can disconnect during best-effort cleanup.
        // A bound session owner must observe cleanup failure before acknowledging its turn.
        const ownsCleanup = (binding: ComputerBinding | undefined) =>
          this.options.transport ||
          binding?.host.host === "gateway" ||
          (binding?.host.host === "node" && binding.host.environmentId !== undefined);
        if (targets.some(([, binding]) => ownsCleanup(binding))) {
          const failures = results.flatMap((result, index) =>
            result.status === "rejected" && ownsCleanup(targets[index]?.[1]) ? [result.reason] : [],
          );
          if (failures.length > 0) {
            throw new AggregateError(failures, "computer: session desktop cleanup failed");
          }
        }
      });
    return await this.disposePromise;
  }
}
