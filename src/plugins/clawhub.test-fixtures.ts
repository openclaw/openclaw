export function clawHubVersionMetadata(overrides: Record<string, unknown> = {}) {
  return {
    version: {
      version: "2026.3.22",
      createdAt: 0,
      changelog: "",
      compatibility: {
        pluginApiRange: ">=2026.3.22",
        minGatewayVersion: "2026.3.0",
      },
      ...overrides,
    },
  };
}

export function clawHubSecurityResponse(
  name = "demo",
  releaseVersion = "2026.3.22",
  trust: Record<string, unknown> = {},
  overview = "No security analysis has been recorded yet.",
) {
  return {
    package: { name, displayName: "Demo", family: "code-plugin" },
    release: { version: releaseVersion },
    overview,
    securityAuditUrl: `https://clawhub.ai/plugins/${name}/security-audit?version=${releaseVersion}`,
    trust: {
      scanStatus: "clean",
      moderationState: null,
      blockedFromDownload: false,
      reasons: [],
      pending: false,
      stale: false,
      ...trust,
    },
  };
}
