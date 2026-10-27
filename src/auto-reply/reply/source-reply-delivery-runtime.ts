import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";

type SourceReplyDeliveryModeOrigin = "stable_policy" | "runtime_default";

export type SourceReplyDeliveryRuntimeOptions = {
  sourceReplyDeliveryModeOrigin?: SourceReplyDeliveryModeOrigin;
  onSourceReplyDeliveryModeResolved?: (mode: SourceReplyDeliveryMode) => void;
};

type SourceReplyDeliveryProjection = {
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  extraSystemPrompt?: string;
  extraSystemPromptTurnContext?: { start: number; text: string };
};

type SourceReplyDeliveryRuntime = {
  readonly origin: SourceReplyDeliveryModeOrigin;
  readonly currentMode: SourceReplyDeliveryMode;
  track: (owner: SourceReplyDeliveryProjection) => void;
  applyMode: (owner: SourceReplyDeliveryProjection, mode: SourceReplyDeliveryMode) => void;
  applyPreparedMode: (owner: SourceReplyDeliveryProjection, mode: SourceReplyDeliveryMode) => void;
};

const sourceReplyDeliveryRuntimeKey = "__openclawSourceReplyDeliveryRuntime" as const;
type SourceReplyDeliveryRuntimeOwner = {
  [sourceReplyDeliveryRuntimeKey]?: SourceReplyDeliveryRuntime;
};

export function bindSourceReplyDeliveryRuntime(
  owner: object,
  runtime: SourceReplyDeliveryRuntime,
): void {
  (owner as SourceReplyDeliveryRuntimeOwner)[sourceReplyDeliveryRuntimeKey] = runtime;
}

export function readSourceReplyDeliveryRuntime(
  owner: object,
): SourceReplyDeliveryRuntime | undefined {
  return (owner as SourceReplyDeliveryRuntimeOwner)[sourceReplyDeliveryRuntimeKey];
}

export function createSourceReplyDeliveryRuntime(params: {
  origin: SourceReplyDeliveryModeOrigin;
  initialMode: SourceReplyDeliveryMode;
  projections: SourceReplyDeliveryProjection[];
  promptComponentByMode: Record<SourceReplyDeliveryMode, string>;
  promptComponentOffset: number | undefined;
  onModeResolved?: (mode: SourceReplyDeliveryMode) => void;
}): SourceReplyDeliveryRuntime {
  const projections = new Set(params.projections);
  let currentMode = params.initialMode;
  const applyMode = (
    owner: SourceReplyDeliveryProjection,
    mode: SourceReplyDeliveryMode,
    updatePrompt: boolean,
  ) => {
    currentMode = mode;
    for (const projection of new Set([...projections, owner])) {
      projection.sourceReplyDeliveryMode = mode;
      if (!updatePrompt) {
        continue;
      }
      const nextComponent = params.promptComponentByMode[mode];
      const prompt = projection.extraSystemPrompt;
      if (!nextComponent || !prompt) {
        continue;
      }
      const offset = params.promptComponentOffset ?? -1;
      const currentComponent = Object.values(params.promptComponentByMode).find(
        (component) => component && prompt.slice(offset, offset + component.length) === component,
      );
      // Replace only the delivery-owned prompt component. Later context additions
      // must survive prepared harness selection instead of restoring a stale prompt.
      if (currentComponent && currentComponent !== nextComponent && offset >= 0) {
        const context = projection.extraSystemPromptTurnContext;
        const end = context ? context.start + context.text.length : -1;
        const valid =
          context &&
          context.text &&
          Number.isInteger(context.start) &&
          context.start >= 0 &&
          prompt.slice(context.start, end) === context.text &&
          (context.start === 0 || prompt.slice(context.start - 2, context.start) === "\n\n") &&
          (end === prompt.length || prompt.slice(end, end + 2) === "\n\n");
        if (valid && context.start <= offset && end >= offset + currentComponent.length) {
          const relative = offset - context.start;
          projection.extraSystemPromptTurnContext = {
            start: context.start,
            text:
              context.text.slice(0, relative) +
              nextComponent +
              context.text.slice(relative + currentComponent.length),
          };
        } else if (valid && context.start >= offset + currentComponent.length) {
          projection.extraSystemPromptTurnContext = {
            ...context,
            start: context.start + nextComponent.length - currentComponent.length,
          };
        } else if (!valid || end > offset) {
          // Never turn a stale annotation into a valid one by replacing its expected bytes.
          projection.extraSystemPromptTurnContext = undefined;
        }
        projection.extraSystemPrompt =
          prompt.slice(0, offset) + nextComponent + prompt.slice(offset + currentComponent.length);
      }
    }
    params.onModeResolved?.(mode);
  };
  return {
    origin: params.origin,
    get currentMode() {
      return currentMode;
    },
    track: (owner) => projections.add(owner),
    applyMode: (owner, mode) => applyMode(owner, mode, false),
    applyPreparedMode: (owner, mode) => applyMode(owner, mode, true),
  };
}
