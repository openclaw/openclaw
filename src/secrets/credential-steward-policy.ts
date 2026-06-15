export type CredentialStewardExposureKind = "none" | "credential_like" | "credential_material";

export type CredentialStewardReasonCode =
  | "no_credential_material"
  | "credential_like_label"
  | "credential_material_detected";

export type CredentialStewardDecision = {
  exposureKind: CredentialStewardExposureKind;
  credentialClassesInvolved: string[];
  dataSensitivity: "low" | "medium" | "critical";
  blocked: boolean;
  reasonCode: CredentialStewardReasonCode;
  redactedSummary: string;
};

export type EvaluateCredentialStewardExposureParams = {
  value?: unknown;
  labels?: readonly string[];
  allowCredentialMaterial?: boolean;
};

const CREDENTIAL_CLASS_ORDER = Object.freeze([
  "api key",
  "password",
  "token",
  "cookie",
  "private key",
  "secret",
]);

const NO_CREDENTIAL_DECISION: CredentialStewardDecision = Object.freeze({
  exposureKind: "none",
  credentialClassesInvolved: [],
  dataSensitivity: "low",
  blocked: false,
  reasonCode: "no_credential_material",
  redactedSummary: "no credential material detected",
});

type CredentialScanState = {
  classes: Set<string>;
  credentialLike: boolean;
  material: boolean;
};

function classifyCredentialLabel(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (/api[-_ ]?key/.test(normalized)) {
    return "api key";
  }
  if (/password|passphrase|passwd/.test(normalized)) {
    return "password";
  }
  if (/authorization|bearer|access[-_ ]?token|refresh[-_ ]?token|\btoken\b/.test(normalized)) {
    return "token";
  }
  if (/cookie|session[-_ ]?cookie/.test(normalized)) {
    return "cookie";
  }
  if (/private[-_ ]?key|wallet/.test(normalized)) {
    return "private key";
  }
  if (/secret|credential/.test(normalized)) {
    return "secret";
  }
  return undefined;
}

function classifyCredentialMaterial(value: string): string | undefined {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
    return "private key";
  }
  if (/\bbearer\s+[a-z0-9._~+/=-]{4,}/i.test(value)) {
    return "token";
  }
  if (
    /\b(?:authorization|access[-_ ]?token|refresh[-_ ]?token|token)\s*[:=]\s*["']?[^\s"']{4,}/i.test(
      value,
    )
  ) {
    return "token";
  }
  if (/\bpassword\s*[:=]\s*["']?[^\s"']{4,}/i.test(value)) {
    return "password";
  }
  if (/\bcookie\s*[:=]\s*["']?[^\s"']{4,}/i.test(value)) {
    return "cookie";
  }
  if (/\bapi[-_ ]?key\s*[:=]\s*["']?[^\s"']{4,}/i.test(value)) {
    return "api key";
  }
  if (/\bsecret\s*[:=]\s*["']?[^\s"']{4,}/i.test(value)) {
    return "secret";
  }
  if (/\b(?:sk|pk)-[a-z0-9][a-z0-9._-]{8,}/i.test(value)) {
    return "api key";
  }
  if (/\b(?:xox[baprs]-|gh[pousr]_|glpat-)[a-z0-9_-]{8,}/i.test(value)) {
    return "token";
  }
  return undefined;
}

function hasConcreteCredentialValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasConcreteCredentialValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((entry) => hasConcreteCredentialValue(entry));
  }
  return false;
}

function scanCredentialValue(value: unknown, state: CredentialScanState): void {
  if (typeof value === "string") {
    const materialClass = classifyCredentialMaterial(value);
    if (materialClass) {
      state.classes.add(materialClass);
      state.material = true;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      scanCredentialValue(entry, state);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const labelClass = classifyCredentialLabel(key);
    if (labelClass) {
      state.classes.add(labelClass);
      state.credentialLike = true;
      if (hasConcreteCredentialValue(entry)) {
        state.material = true;
      }
    }
    scanCredentialValue(entry, state);
  }
}

function sortedCredentialClasses(classes: Set<string>): string[] {
  return CREDENTIAL_CLASS_ORDER.filter((entry) => classes.has(entry));
}

export function evaluateCredentialStewardExposure(
  params: EvaluateCredentialStewardExposureParams,
): CredentialStewardDecision {
  const state: CredentialScanState = {
    classes: new Set(),
    credentialLike: false,
    material: false,
  };
  for (const label of params.labels ?? []) {
    const labelClass = classifyCredentialLabel(label);
    if (labelClass) {
      state.classes.add(labelClass);
      state.credentialLike = true;
      if (hasConcreteCredentialValue(params.value)) {
        state.material = true;
      }
    }
  }
  scanCredentialValue(params.value, state);

  const credentialClassesInvolved = sortedCredentialClasses(state.classes);
  if (state.material) {
    return {
      exposureKind: "credential_material",
      credentialClassesInvolved,
      dataSensitivity: "critical",
      blocked: params.allowCredentialMaterial !== true,
      reasonCode: "credential_material_detected",
      redactedSummary: "credential material redacted",
    };
  }
  if (state.credentialLike) {
    return {
      exposureKind: "credential_like",
      credentialClassesInvolved,
      dataSensitivity: "medium",
      blocked: false,
      reasonCode: "credential_like_label",
      redactedSummary: "credential label detected without material",
    };
  }
  return NO_CREDENTIAL_DECISION;
}
