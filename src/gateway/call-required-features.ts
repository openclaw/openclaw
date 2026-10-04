export function ensureGatewaySupportsRequiredFeatures(params: {
  required: string[] | undefined;
  supported: string[] | undefined;
  kind: "method" | "capability";
  attemptedMethod: string;
}): void {
  const required = (params.required ?? []).map((entry) => entry.trim()).filter(Boolean);
  if (required.length === 0) {
    return;
  }
  const supported = new Set((params.supported ?? []).map((entry) => entry.trim()).filter(Boolean));
  for (const feature of required) {
    if (!supported.has(feature)) {
      throw new Error(
        `active gateway does not support required ${params.kind} "${feature}" for "${params.attemptedMethod}". Update or restart the active gateway and try again.`,
      );
    }
  }
}
