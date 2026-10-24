import { createServer, type RequestListener } from "node:http";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { applyLinkUnderstanding } from "./apply.js";

vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/net/fetch-guard.js")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({
        ...params,
        // Exercise the real guarded HTTP transport against only this test's fixture.
        lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
        policy: { ...params.policy, allowPrivateNetwork: true },
      }),
  };
});

async function serve(handler: RequestListener) {
  const server = createServer(handler);
  const base = await listenLoopback(server);
  onTestFinished(() => closeHttpServer(server));
  return base.replace("127.0.0.1", "loopback.test");
}

const echoStdin = ["-e", "process.stdin.pipe(process.stdout)"];

it.each([
  ["full", "[Documentation][docs]"],
  ["collapsed", "[docs][]"],
  ["shortcut", "[docs]"],
  ["image", "![Documentation][docs]"],
  ["URL label", "[{base}/label][docs]"],
  ["unused definition", "Documentation"],
  ["unresolved", "[missing][unknown]"],
  ["inline", "[Documentation]({base}/citation)"],
])("preserves the bare-link budget with %s Markdown syntax", async (name, label) => {
  const requests: string[] = [];
  const base = await serve((req, res) => {
    requests.push(req.url ?? "");
    res.end(req.url);
  });
  const definition =
    name === "unresolved" || name === "inline" ? "" : `\n\n[docs]: ${base}/citation`;
  const ctx = finalizeInboundContext({
    Body: `${label.replace("{base}", base)}${definition}\n\nPlease read ${base}/requested`,
  });
  await applyLinkUnderstanding({
    ctx,
    cfg: {
      tools: {
        links: {
          maxLinks: 1,
          models: [{ command: process.execPath, args: echoStdin }],
        },
      },
    },
  });
  expect(requests).toEqual(["/requested"]);
  expect(ctx.LinkUnderstanding).toEqual(["/requested"]);
});
