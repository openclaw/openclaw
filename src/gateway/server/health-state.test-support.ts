export function createGatewaySnapshotFixture() {
  return {
    presence: [],
    health: {},
    stateVersion: { presence: 1, health: 1 },
    uptimeMs: 1,
    sessionDefaults: {
      defaultAgentId: "main",
      mainKey: "main",
      mainSessionKey: "main",
      scope: "per-sender",
    },
  };
}
