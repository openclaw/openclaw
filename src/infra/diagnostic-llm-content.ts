/** Effective model-content capture switches after diagnostics/OTel gates are applied. */
export type DiagnosticModelContentCapturePolicy = {
  inputMessages: boolean;
  outputMessages: boolean;
  toolInputs: boolean;
  toolOutputs: boolean;
  systemPrompt: boolean;
  toolDefinitions: boolean;
  anyModelContent: boolean;
};

const NO_MODEL_CONTENT_CAPTURE: DiagnosticModelContentCapturePolicy = Object.freeze({
  inputMessages: false,
  outputMessages: false,
  toolInputs: false,
  toolOutputs: false,
  systemPrompt: false,
  toolDefinitions: false,
  anyModelContent: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function withDerivedFields(
  policy: Omit<DiagnosticModelContentCapturePolicy, "anyModelContent">,
): DiagnosticModelContentCapturePolicy {
  return {
    ...policy,
    // Tool input/output capture is handled separately from prompt/response
    // capture, so only model-visible content contributes to anyModelContent.
    anyModelContent:
      policy.inputMessages ||
      policy.outputMessages ||
      policy.systemPrompt ||
      policy.toolDefinitions,
  };
}

/** Resolves safe default-off LLM content capture policy from raw config. */
export function resolveDiagnosticModelContentCapturePolicy(
  config: unknown,
): DiagnosticModelContentCapturePolicy {
  if (!isRecord(config)) {
    return NO_MODEL_CONTENT_CAPTURE;
  }
  const diagnostics = config.diagnostics;
  if (!isRecord(diagnostics) || diagnostics.enabled === false) {
    return NO_MODEL_CONTENT_CAPTURE;
  }
  const otel = diagnostics.otel;
  if (!isRecord(otel) || otel.enabled !== true || otel.traces === false) {
    return NO_MODEL_CONTENT_CAPTURE;
  }

  const captureContent = otel.captureContent;
  if (captureContent === true) {
    // Boolean opt-in captures request/response content and tool definitions,
    // but keeps system prompts behind the more explicit object form.
    return withDerivedFields({
      inputMessages: true,
      outputMessages: true,
      toolInputs: true,
      toolOutputs: true,
      systemPrompt: false,
      toolDefinitions: true,
    });
  }
  if (!isRecord(captureContent) || captureContent.enabled !== true) {
    return NO_MODEL_CONTENT_CAPTURE;
  }
  return withDerivedFields({
    inputMessages: captureContent.inputMessages === true,
    outputMessages: captureContent.outputMessages === true,
    toolInputs: captureContent.toolInputs === true,
    toolOutputs: captureContent.toolOutputs === true,
    systemPrompt: captureContent.systemPrompt === true,
    toolDefinitions: captureContent.toolDefinitions === true,
  });
}
