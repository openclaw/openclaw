type ResolveCustomerIdParams = {
  config: {
    quota?: {
      customerHeader?: string;
      customerEnvVar?: string;
    };
  };
  senderId?: string | null;
  sessionKey?: string;
  headers?: Record<string, string | string[] | undefined>;
};

export function resolveCustomerId(params: ResolveCustomerIdParams): string | null {
  const { config, senderId, headers } = params;

  // Priority 1: Environment variable (server-side deployment identity)
  const envVar = config.quota?.customerEnvVar ?? "OPENCLAW_CUSTOMER_ID";
  const envValue = process.env[envVar];
  if (envValue) {
    return envValue;
  }

  // Priority 2: Custom header
  if (headers) {
    const headerName = config.quota?.customerHeader ?? "x-customer-id";
    const headerValue = headers[headerName] ?? headers[headerName.toLowerCase()];
    const resolved = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (resolved) {
      return resolved;
    }
  }

  // Priority 3: senderId from messaging channel
  if (senderId) {
    return senderId;
  }

  return null;
}
