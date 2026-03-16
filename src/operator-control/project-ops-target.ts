export const PROJECT_OPS_PROXY_BASE_PATH = "/mission-control/api/project-ops" as const;

export type ProjectOpsCommand = "status" | "sync" | "task" | "update";
export type ProjectOpsTargetMode = "control-plane-proxy" | "direct-deb";

export type ProjectOpsResolvedTarget = {
  mode: ProjectOpsTargetMode;
  baseUrl: string;
  endpoint: string;
  readyEndpoint: string;
  authToken: string | null;
  authEnv: string;
};

function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/u, "");
}

function joinEndpoint(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

export function resolveDirectDebBaseUrl(): string | null {
  return normalizeBaseUrl(process.env.OPENCLAW_OPERATOR_DEB_URL);
}

export function resolveDirectDebSharedSecret(): string | null {
  const secret =
    process.env.OPENCLAW_OPERATOR_DEB_SHARED_SECRET?.trim() ||
    process.env.OPENCLAW_DEB_SHARED_SECRET?.trim() ||
    process.env.DEB_SHARED_SECRET?.trim();
  return secret || null;
}

export function resolveProjectOpsControlPlaneBaseUrl(): string | null {
  return normalizeBaseUrl(process.env.OPENCLAW_OPERATOR_CONTROL_PLANE_URL);
}

export function resolveProjectOpsControlPlaneSharedSecret(): string | null {
  return process.env.OPENCLAW_OPERATOR_CONTROL_PLANE_SHARED_SECRET?.trim() || null;
}

export function resolveInboundProjectOpsProxySharedSecret(): string | null {
  return (
    process.env.OPENCLAW_OPERATOR_CONTROL_PLANE_SHARED_SECRET?.trim() ||
    process.env.OPENCLAW_OPERATOR_INTERNAL_CONTROL_SHARED_SECRET?.trim() ||
    process.env.OPENCLAW_OPERATOR_ANGELA_SHARED_SECRET?.trim() ||
    process.env.OPENCLAW_ANGELA_SHARED_SECRET?.trim() ||
    null
  );
}

export function resolveProjectOpsCommandTarget(
  command: ProjectOpsCommand,
): ProjectOpsResolvedTarget | null {
  const controlPlaneBaseUrl = resolveProjectOpsControlPlaneBaseUrl();
  if (controlPlaneBaseUrl) {
    return {
      mode: "control-plane-proxy",
      baseUrl: controlPlaneBaseUrl,
      endpoint: joinEndpoint(controlPlaneBaseUrl, `${PROJECT_OPS_PROXY_BASE_PATH}/${command}`),
      readyEndpoint: joinEndpoint(controlPlaneBaseUrl, `${PROJECT_OPS_PROXY_BASE_PATH}/ready`),
      authToken: resolveProjectOpsControlPlaneSharedSecret(),
      authEnv: "OPENCLAW_OPERATOR_CONTROL_PLANE_SHARED_SECRET",
    };
  }

  if (command === "task") {
    return null;
  }

  const debBaseUrl = resolveDirectDebBaseUrl();
  if (!debBaseUrl) {
    return null;
  }
  return {
    mode: "direct-deb",
    baseUrl: debBaseUrl,
    endpoint: joinEndpoint(debBaseUrl, command),
    readyEndpoint: joinEndpoint(debBaseUrl, "/ready"),
    authToken: resolveDirectDebSharedSecret(),
    authEnv: "OPENCLAW_OPERATOR_DEB_SHARED_SECRET",
  };
}

export function resolveProjectOpsEventTarget(): ProjectOpsResolvedTarget | null {
  const controlPlaneBaseUrl = resolveProjectOpsControlPlaneBaseUrl();
  if (controlPlaneBaseUrl) {
    return {
      mode: "control-plane-proxy",
      baseUrl: controlPlaneBaseUrl,
      endpoint: joinEndpoint(controlPlaneBaseUrl, `${PROJECT_OPS_PROXY_BASE_PATH}/operator/events`),
      readyEndpoint: joinEndpoint(controlPlaneBaseUrl, `${PROJECT_OPS_PROXY_BASE_PATH}/ready`),
      authToken: resolveProjectOpsControlPlaneSharedSecret(),
      authEnv: "OPENCLAW_OPERATOR_CONTROL_PLANE_SHARED_SECRET",
    };
  }

  const debBaseUrl = resolveDirectDebBaseUrl();
  if (!debBaseUrl) {
    return null;
  }
  return {
    mode: "direct-deb",
    baseUrl: debBaseUrl,
    endpoint: joinEndpoint(debBaseUrl, "/operator/events"),
    readyEndpoint: joinEndpoint(debBaseUrl, "/ready"),
    authToken: resolveDirectDebSharedSecret(),
    authEnv: "OPENCLAW_OPERATOR_DEB_SHARED_SECRET",
  };
}
