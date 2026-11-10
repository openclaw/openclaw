import { randomUUID } from "node:crypto";
import http from "node:http";
import { startTelegramProofIngress } from "../../../scripts/mantis/telegram-proof-ingress.mts";

const expected = process.argv[2];
// This process owns its cwd. Relative bind/connect paths stay short without moving
// any socket or provider artifact outside the test's temporary directory.
const socket = process.platform === "win32" ? `\\\\.\\pipe\\mantis-${randomUUID()}` : "api.sock";
const ingress = await startTelegramProofIngress({
  socket,
  alias: "1:fixture",
  sutToken: "private-token",
  testerId: "43",
  providerLog: "provider.ndjson",
  plan: {
    claim: "fixture",
    actions: [{ type: "send", atMs: 0, text: "hello" }],
    modelReplies: ["reply"],
    settings: { streaming: "off", nativeCommands: false },
    maxDurationMs: 1000,
    expectations: ["reply"],
  },
  lease: {
    assertHealthy() {
      if (expected === "authority_unavailable") {
        throw new Error("private expired lease");
      }
    },
    whenUnhealthy: new Promise<Error>(() => {}),
  },
  fetchImpl: async () => {
    if (expected === "network_failure") {
      throw new Error("private network secret");
    }
    return new Response("private upstream secret", { status: 500 });
  },
});
try {
  const request = () =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: socket,
          path:
            expected === "scope_rejected"
              ? "/private-wrong-capability"
              : "/telegram/bot1:fixture/getMe",
          method: "POST",
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.end(expected === "malformed_request" ? "private-not-json" : "{}");
    });
  const statuses = [await request()];
  const initialDiagnostics = ingress.getDiagnostics();
  for (let i = 0; i < 20; i++) {
    statuses.push(await request());
  }
  const diagnostics = ingress.getDiagnostics();
  const copy = ingress.getDiagnostics();
  copy.splice(0);
  console.log(
    JSON.stringify({
      statuses,
      initialDiagnostics,
      diagnostics,
      retainedCount: ingress.getDiagnostics().length,
    }),
  );
} finally {
  await ingress.close();
}
