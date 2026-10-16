module.exports = {
  id: "chat-cli-account-fixture",
  register(api) {
    const fixtures = globalThis[Symbol.for("openclaw.test.cliAccountFixtureBackends")];
    const backends = fixtures?.get(api.pluginConfig.fixtureKey);
    if (!backends) throw new Error("Owned CLI fixture controller is unavailable");
    for (const backend of backends) api.registerCliBackend(backend);
  },
};
