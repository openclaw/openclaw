export function ensureGatewaySupportsRequiredMethods(params: {
  requiredMethods: string[] | undefined;
  methods: string[] | undefined;
  attemptedMethod: string;
}): void {
  const requiredMethods = Array.isArray(params.requiredMethods)
    ? params.requiredMethods.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : [];
  if (requiredMethods.length === 0) {
    return;
  }
  const supportedMethods = new Set(
    (Array.isArray(params.methods) ? params.methods : [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  for (const method of requiredMethods) {
    if (supportedMethods.has(method)) {
      continue;
    }
    throw new Error(
      [
        `active gateway does not support required method "${method}" for "${params.attemptedMethod}".`,
        "Update or restart the active gateway and try again.",
      ].join(" "),
    );
  }
}

export function ensureGatewaySupportsRequiredCapabilities(params: {
  requiredCapabilities: string[] | undefined;
  capabilities: string[] | undefined;
  attemptedMethod: string;
}): void {
  const required = (params.requiredCapabilities ?? []).map((entry) => entry.trim()).filter(Boolean);
  if (required.length === 0) {
    return;
  }
  const supported = new Set(
    (params.capabilities ?? []).map((entry) => entry.trim()).filter(Boolean),
  );
  for (const capability of required) {
    if (!supported.has(capability)) {
      throw new Error(
        `active gateway does not support required capability "${capability}" for "${params.attemptedMethod}". Update or restart the active gateway and try again.`,
      );
    }
  }
}
