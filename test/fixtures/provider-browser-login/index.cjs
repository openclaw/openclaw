const { randomUUID } = require("node:crypto");
const provider = "browser-login-fixture";
module.exports = {
  id: provider,
  register(api) {
    const origin = api.pluginConfig.origin;
    api.registerProvider({
      id: provider,
      label: "Browser login fixture",
      auth: [
        {
          id: "oauth",
          label: "Fixture browser sign-in",
          kind: "oauth",
          async run({ oauth }) {
            if (!oauth.authorize)
              throw new Error("Fixture login requires the real secure browser callback");
            const state = randomUUID();
            const result = await oauth.authorize({
              state,
              timeoutMs: 60000,
              buildAuthorizationUrl(redirectUrl) {
                const url = new URL("/authorize", origin);
                url.searchParams.set("redirect_uri", redirectUrl);
                url.searchParams.set("state", state);
                return url.href;
              },
            });
            const response = await fetch(new URL("/token", origin), {
              method: "POST",
              body: JSON.stringify(result),
            });
            if (!response.ok) throw new Error("Fixture authorization code was rejected");
            const { key } = await response.json();
            return {
              profiles: [
                {
                  profileId: `${provider}:default`,
                  credential: { type: "api_key", provider, key },
                },
              ],
            };
          },
        },
      ],
      catalog: {
        order: "profile",
        async run(ctx) {
          const { discoveryApiKey } = ctx.resolveProviderAuth(provider);
          if (!discoveryApiKey) return null;
          const response = await fetch(new URL("/models", origin), {
            headers: { Authorization: `Bearer ${discoveryApiKey}` },
          });
          if (!response.ok) throw new Error("Fixture catalog requires the saved credential");
          return {
            provider: {
              baseUrl: origin,
              api: "openai-completions",
              models: await response.json(),
            },
          };
        },
      },
    });
  },
};
