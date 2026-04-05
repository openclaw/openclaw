import fs from "node:fs/promises";
import path from "node:path";

export type CoreInstallPathSeverity = "info" | "warn" | "error";

export type CoreInstallPathDriftKind =
  | "none"
  | "service-points-elsewhere"
  | "entrypoint-shape-mismatch"
  | "config-path-mismatch"
  | "insufficient-data";

export type CoreInstallPathIssue = {
  driftKind: CoreInstallPathDriftKind;
  severity: CoreInstallPathSeverity;
  summary: string;
  packageRoot?: string;
  expectedEntrypoint?: string | null;
  serviceEntrypoint?: string | null;
  configPathCli?: string | null;
  configPathService?: string | null;
};

function findGatewayEntrypoint(programArguments?: string[] | null): string | null {
  if (!programArguments || programArguments.length === 0) {
    return null;
  }
  const gatewayIndex = programArguments.indexOf("gateway");
  if (gatewayIndex <= 0) {
    return null;
  }
  return programArguments[gatewayIndex - 1] ?? null;
}

async function normalizePath(value: string | null | undefined): Promise<string | null> {
  if (!value || !value.trim()) {
    return null;
  }
  const resolved = path.resolve(value.trim());
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

function deriveInstallRootFromEntrypoint(entrypoint: string | null | undefined): string | null {
  if (!entrypoint) {
    return null;
  }
  const normalized = path.resolve(entrypoint);
  const match = normalized.match(/^(.*?)[/\\]dist[/\\][^/\\]+\.(?:js|mjs|cjs|ts)$/i);
  if (!match) {
    return null;
  }
  return path.resolve(match[1] ?? normalized);
}

export async function detectCoreInstallPathIssue(params: {
  packageRoot?: string | null;
  expectedProgramArguments?: string[] | null;
  serviceProgramArguments?: string[] | null;
  configPathCli?: string | null;
  configPathService?: string | null;
}): Promise<CoreInstallPathIssue> {
  const packageRoot = params.packageRoot ? path.resolve(params.packageRoot) : undefined;
  const expectedEntrypoint = findGatewayEntrypoint(params.expectedProgramArguments);
  const serviceEntrypoint = findGatewayEntrypoint(params.serviceProgramArguments);
  const normalizedExpectedEntrypoint = await normalizePath(expectedEntrypoint);
  const normalizedServiceEntrypoint = await normalizePath(serviceEntrypoint);
  const expectedRoot =
    packageRoot ?? deriveInstallRootFromEntrypoint(normalizedExpectedEntrypoint ?? expectedEntrypoint);
  const serviceRoot = deriveInstallRootFromEntrypoint(
    normalizedServiceEntrypoint ?? serviceEntrypoint,
  );
  const normalizedConfigCli = await normalizePath(params.configPathCli);
  const normalizedConfigService = await normalizePath(params.configPathService);

  if (normalizedConfigCli && normalizedConfigService && normalizedConfigCli !== normalizedConfigService) {
    return {
      driftKind: "config-path-mismatch",
      severity: "warn",
      summary: "CLI and service resolve different config paths.",
      packageRoot: expectedRoot ?? undefined,
      expectedEntrypoint,
      serviceEntrypoint,
      configPathCli: params.configPathCli ?? null,
      configPathService: params.configPathService ?? null,
    };
  }

  if (expectedRoot && serviceRoot && expectedRoot !== serviceRoot) {
    return {
      driftKind: "service-points-elsewhere",
      severity: "error",
      summary: "Gateway service entrypoint resolves outside the current install root.",
      packageRoot: expectedRoot,
      expectedEntrypoint,
      serviceEntrypoint,
      configPathCli: params.configPathCli ?? null,
      configPathService: params.configPathService ?? null,
    };
  }

  if (
    normalizedExpectedEntrypoint &&
    normalizedServiceEntrypoint &&
    normalizedExpectedEntrypoint !== normalizedServiceEntrypoint &&
    expectedRoot &&
    serviceRoot &&
    expectedRoot === serviceRoot
  ) {
    return {
      driftKind: "entrypoint-shape-mismatch",
      severity: "warn",
      summary: "Service and current install share the same root but use different gateway entrypoint files.",
      packageRoot: expectedRoot,
      expectedEntrypoint,
      serviceEntrypoint,
      configPathCli: params.configPathCli ?? null,
      configPathService: params.configPathService ?? null,
    };
  }

  if (!expectedRoot || !serviceEntrypoint) {
    return {
      driftKind: "insufficient-data",
      severity: "info",
      summary: "Install-path check could not fully verify the service entrypoint.",
      packageRoot: expectedRoot ?? undefined,
      expectedEntrypoint,
      serviceEntrypoint,
      configPathCli: params.configPathCli ?? null,
      configPathService: params.configPathService ?? null,
    };
  }

  return {
    driftKind: "none",
    severity: "info",
    summary: "Current install root and gateway service entrypoint appear aligned.",
    packageRoot: expectedRoot,
    expectedEntrypoint,
    serviceEntrypoint,
    configPathCli: params.configPathCli ?? null,
    configPathService: params.configPathService ?? null,
  };
}

export function formatCoreInstallPathIssue(issue: CoreInstallPathIssue): string {
  const badge =
    issue.severity === "error" ? "error" : issue.severity === "warn" ? "warn" : "ok";
  const detailParts = [
    issue.driftKind !== "none" ? issue.driftKind : null,
    issue.packageRoot ? `root ${issue.packageRoot}` : null,
  ].filter(Boolean);
  return `${badge} · ${issue.summary}${detailParts.length > 0 ? ` · ${detailParts.join(" · ")}` : ""}`;
}
