// Synthetic provider whose OAuth sign-in can be revoked at a local fixture endpoint.
module.exports = {
  id: "acme",
  register(api) {
    const origin = api.pluginConfig.origin;
    api.registerProvider({
      id: "acme",
      label: "Acme Cloud Plan",
      auth: [
        {
          id: "oauth",
          label: "Sign in with Acme",
          kind: "oauth",
          async run() {
            throw new Error("The fixture account is seeded; sign-in is not part of this proof");
          },
          async revoke({ credential, signal }) {
            const response = await fetch(new URL("/revoke", origin), {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ token: credential.refresh }),
              signal,
            });
            if (!response.ok) {
              throw new Error(`Acme could not revoke access right now (HTTP ${response.status}).`);
            }
          },
          disconnectLabel: "Disconnect Acme Account",
          accountManagementUrl: "https://acme.example/connections",
        },
      ],
    });
  },
};
