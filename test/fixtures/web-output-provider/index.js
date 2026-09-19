import fs from "node:fs";

const id = "qa-web-output";
const payload = "x".repeat(2 * 1024 * 1024) + "\nqa-web-output-tail\n";

export default {
  id,
  register(api) {
    let invoked = false;
    let mode;
    const event = (name, extra = {}) => {
      fs.writeSync(
        2,
        "@@qa-web-output@@" +
          JSON.stringify({ event: name, pid: process.pid, ppid: process.ppid, mode, ...extra }) +
          "\n",
      );
    };

    process.on("exit", (code) => {
      if (invoked) event("exit", { code });
    });
    const provider = {
      id,
      label: "Synthetic web output provider",
      hint: "Offline fixture for CLI output completion",
      requiresCredential: false,
      envVars: [],
      credentialPath: "",
      placeholder: "",
      signupUrl: "https://example.invalid",
      getCredentialValue: () => undefined,
      setCredentialValue: () => undefined,
      createTool: () => ({
        description: "Return deterministic fixture output without networking",
        parameters: {
          type: "object",
          properties: { query: { type: "string" }, url: { type: "string" } },
          additionalProperties: true,
        },
        async execute(args) {
          mode = typeof args.query === "string" ? args.query : new URL(args.url).pathname.slice(1);
          if (mode !== "failure") {
            throw new Error("Unsupported synthetic web output mode");
          }
          invoked = true;
          event("execute");
          event("return", { payloadBytes: Buffer.byteLength(payload), ok: false });
          return {
            ok: false,
            statusCode: 503,
            error: { message: "Synthetic failure" },
            text: payload,
          };
        },
      }),
    };
    api.registerWebFetchProvider(provider);
    api.registerWebSearchProvider(provider);
  },
};
