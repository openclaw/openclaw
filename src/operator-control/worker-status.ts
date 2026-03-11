function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/u, "");
}

export function resolve2TonyBaseUrl(): string | null {
  return normalizeBaseUrl(
    process.env.OPENCLAW_OPERATOR_2TONY_URL ??
      process.env.BT_2TONY_BASE_URL ??
      process.env.TWO_TONY_BASE_URL,
  );
}

export function resolve2TonySharedSecret(): string | null {
  const secret =
    process.env.OPENCLAW_OPERATOR_2TONY_SHARED_SECRET?.trim() ||
    process.env.BT_2TONY_SHARED_SECRET?.trim() ||
    process.env.TWO_TONY_SHARED_SECRET?.trim();
  return secret || null;
}

function resolveAngelaBaseUrl(): string | null {
  return normalizeBaseUrl(process.env.OPENCLAW_OPERATOR_ANGELA_URL);
}

function resolveAngelaSharedSecret(): string | null {
  const secret =
    process.env.OPENCLAW_OPERATOR_ANGELA_SHARED_SECRET?.trim() ||
    process.env.OPENCLAW_ANGELA_SHARED_SECRET?.trim();
  return secret || null;
}

export function resolveOperatorReceiptBaseUrl(): string | null {
  return normalizeBaseUrl(
    process.env.OPENCLAW_OPERATOR_RECEIPT_BASE_URL ??
      process.env.OPENCLAW_PUBLIC_BASE_URL ??
      process.env.GATEWAY_BASE_URL,
  );
}

export function resolveOperatorReceiptTemplate(): string | null {
  const explicit = process.env.OPENCLAW_OPERATOR_RECEIPT_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const base = resolveOperatorReceiptBaseUrl();
  if (!base) {
    return null;
  }
  return `${base}/mission-control/api/tasks/{taskId}/receipts`;
}

export type OperatorWorkerStatusSnapshot = {
  dispatchTransport: "2tony-http";
  configured: boolean;
  baseUrl: string | null;
  receiptTemplate: string | null;
  authScheme: "bearer" | null;
  authEnv: string | null;
  authConfigured: boolean;
};

export type OperatorAngelaStatusSnapshot = {
  dispatchTransport: "angela-http";
  configured: boolean;
  baseUrl: string | null;
  authScheme: "bearer" | null;
  authEnv: string | null;
  authConfigured: boolean;
};

export function getOperatorWorkerStatus(): OperatorWorkerStatusSnapshot {
  const baseUrl = resolve2TonyBaseUrl();
  const sharedSecret = resolve2TonySharedSecret();
  return {
    dispatchTransport: "2tony-http",
    configured: Boolean(baseUrl),
    baseUrl,
    receiptTemplate: resolveOperatorReceiptTemplate(),
    authScheme: "bearer",
    authEnv: "OPENCLAW_OPERATOR_2TONY_SHARED_SECRET",
    authConfigured: Boolean(sharedSecret),
  };
}

export function getOperatorAngelaStatus(): OperatorAngelaStatusSnapshot {
  const baseUrl = resolveAngelaBaseUrl();
  const sharedSecret = resolveAngelaSharedSecret();
  return {
    dispatchTransport: "angela-http",
    configured: Boolean(baseUrl),
    baseUrl,
    authScheme: "bearer",
    authEnv: "OPENCLAW_OPERATOR_ANGELA_SHARED_SECRET",
    authConfigured: Boolean(sharedSecret),
  };
}
