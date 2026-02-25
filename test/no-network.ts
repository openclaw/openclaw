import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import type { Dispatcher } from "undici";
import { beforeAll, afterAll, vi } from "vitest";

let priorDispatcher: Dispatcher;

type Addr = { address: string; family: 4 | 6 };
const mapHost = (host: string): Addr[] => {
  const raw = String(host || "");
  const h = raw.toLowerCase();

  // 1) If it's already an IP literal, return it (no DNS needed).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    return [{ address: h, family: 4 }];
  }
  if (/^[0-9a-f:]+$/i.test(h)) {
    return [{ address: raw, family: 6 }];
  }

  // loopback
  if (h === "localhost" || h === "127.0.0.1") {
    return [{ address: "127.0.0.1", family: 4 }];
  }
  if (h === "::1" || h === "[::1]") {
    return [{ address: "::1", family: 6 }];
  }

  // stable fixtures used across tests
  if (h === "example.com") {
    return [{ address: "93.184.216.34", family: 4 }];
  }
  if (h === "private.test") {
    return [{ address: "127.0.0.1", family: 4 }];
  }

  // 2) Allow common external API hosts referenced by tests (resolve to stable public IP).
  const allow = new Set([
    "api.voyageai.com",
    "api.openai.com",
    "generativelanguage.googleapis.com",
    "api.mistral.ai",
    "api.telegram.org",
    "files.slack.com",
  ]);
  if (allow.has(h)) {
    return [{ address: "93.184.216.34", family: 4 }];
  }

  const err = new Error(`DNS disabled in tests: `) as Error & { code?: string };
  err.code = "ENOTFOUND";
  throw err;
};

const lookupPromise = async (hostname: unknown, options?: unknown) => {
  const opts = options ?? {};
  const wantAll = typeof opts === "object" && !!opts.all;
  const addrs = mapHost(hostname);
  if (wantAll) {
    return addrs;
  }
  return { address: addrs[0].address, family: addrs[0].family };
};

vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    lookup: (hostname: unknown, options: unknown, cb: unknown) => {
      const callback = typeof options === "function" ? options : cb;
      const opts = typeof options === "object" && options ? options : {};
      try {
        const addrs = mapHost(hostname);
        if (opts.all) {
          return callback(null, addrs);
        }
        return callback(null, addrs[0].address, addrs[0].family);
      } catch (e) {
        return callback(e);
      }
    },
    promises: { ...actual.promises, lookup: lookupPromise },
  };
});

vi.mock("node:dns/promises", async () => {
  const actual = await vi.importActual<typeof import("node:dns/promises")>("node:dns/promises");
  return { ...actual, lookup: lookupPromise };
});

beforeAll(() => {
  priorDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  // allow loopback (scheme optional)
  mockAgent.enableNetConnect(/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/);
  setGlobalDispatcher(mockAgent);
});

afterAll(() => {
  if (priorDispatcher) {
    setGlobalDispatcher(priorDispatcher);
  }
});
