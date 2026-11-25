import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveRootSigner,
  encodeKit,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateKitSecret,
  ROOT_EPOCH,
  type RebindPreparation,
  type SignedStatement,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { authorizeOperatorScopesForMethod } from "../gateway/method-scopes.js";
import { ExpectedCliError } from "./expected-cli-error.js";
import { callGatewayFromCli } from "./gateway-rpc.js";
import { registerIdCli } from "./id-cli.js";

vi.mock(import("./gateway-rpc.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  callGatewayFromCli: vi.fn(),
}));
vi.mock(import("@openclaw/media-core/read-byte-stream-with-limit"), async (importOriginal) => ({
  ...(await importOriginal()),
  readByteStreamWithLimit: () => Promise.resolve(Buffer.from(kitText)),
}));

let kitText: string;
let preparation: RebindPreparation;
let bindingSeq: number;
let readFailure: Error | undefined;
let commitFailure: Error | undefined;
let followUpError: string | undefined;
let commits: SignedStatement<"ServerBinding">[];
let output: string;
let originalExitCode: typeof process.exitCode;

beforeAll(async () => {
  const secret = generateKitSecret();
  kitText = await encodeKit(secret);
  const root = await deriveRootSigner(secret);
  secret.fill(0);
  preparation = {
    claw_id: "c".repeat(32),
    hostname: "studio-k7x2q.claws.example.test",
    root_pub: formatEd25519PublicKey(root.publicKey),
    k_srv: formatIrohEndpointKey(new Uint8Array(32).fill(2)),
    k_gw: formatEd25519PublicKey(new Uint8Array(32).fill(3)),
    binding_seq: 2,
    root_epoch: ROOT_EPOCH,
    current: {
      k_srv: formatIrohEndpointKey(new Uint8Array(32).fill(4)),
      k_gw: formatEd25519PublicKey(new Uint8Array(32).fill(5)),
      binding_seq: 1,
    },
    published: { error: "not_found", detail: "not registered" },
  };
});

beforeEach(() => {
  bindingSeq = 1;
  readFailure = undefined;
  commitFailure = undefined;
  followUpError = undefined;
  commits = [];
  output = "";
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  // Fixed RPC I/O with the production scope gate, not a permissive method mock.
  vi.mocked(callGatewayFromCli)
    .mockClear()
    .mockImplementation(async (method, _opts, params, extra) => {
      const authorization = authorizeOperatorScopesForMethod(method, extra?.scopes ?? [], params);
      if (!authorization.allowed) {
        throw new Error(`missing scope: ${authorization.missingScope}`);
      }
      if (method === "openclawId.status") {
        return { status: { state: "on" }, link: { linked: true } };
      }
      if (method === "openclawId.people") {
        if (readFailure) {
          throw readFailure;
        }
        return {
          link: {
            binding: {
              bindingSeq,
              publishedBindingSeq: bindingSeq,
              kSrv: preparation.k_srv,
              kGw: preparation.k_gw,
            },
          },
        };
      }
      const input = params as { action: string; binding: SignedStatement<"ServerBinding"> };
      if (input.action === "rebind_prepare") {
        return {
          ...preparation,
          binding_seq: bindingSeq + 1,
          k_srv: formatIrohEndpointKey(new Uint8Array(32).fill(bindingSeq + 10)),
          k_gw: formatEd25519PublicKey(new Uint8Array(32).fill(bindingSeq + 20)),
          current: {
            k_srv: commits.at(-1)?.body.k_srv ?? preparation.current.k_srv,
            k_gw: commits.at(-1)?.body.k_gw ?? preparation.current.k_gw,
            binding_seq: bindingSeq,
          },
        };
      }
      if (input.action === "rebind_commit") {
        if (commitFailure) {
          throw commitFailure;
        }
        commits.push(input.binding);
        bindingSeq = input.binding.body.binding_seq;
        return {
          ok: true,
          bindingSeq,
          ...(followUpError
            ? { moved: true, published: null, followUpError, nextStep: "openclaw id status" }
            : {}),
        };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    });
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

const validRebind = ["--kit-stdin", "--yes", "--code", "test-link-code"];
async function run(command: "status" | "rebind", json = true, rebindArgs = validRebind) {
  const program = new Command().exitOverride();
  registerIdCli(program);
  const args = [command, ...(json ? ["--json"] : []), ...(command === "rebind" ? rebindArgs : [])];
  await program.parseAsync(["id", ...args], { from: "user" });
}

describe("registered id commands", () => {
  it.each(["status", "rebind"] as const)(
    "authorizes %s through the real method scope gate",
    async (command) => {
      await run(command);
      expect(JSON.parse(output)).toMatchObject(
        command === "status"
          ? { people: { binding: { bindingSeq: 1 } } }
          : { moved: true, bindingSeq: 2, published: true },
      );
      expect(process.exitCode).toBeUndefined();
    },
  );

  it.each([true, false])(
    "reports an accepted commit when its publication read fails (json=%s)",
    async (json) => {
      readFailure = new Error("connection closed");
      await expect(run("rebind", json)).resolves.toBeUndefined();
      expect(commits).toHaveLength(1);
      expect(process.exitCode).toBe(2);
      if (json) {
        expect(JSON.parse(output)).toEqual({
          moved: true,
          bindingSeq: 2,
          published: null,
          publicationError: "connection closed",
          nextStep: "openclaw id status",
        });
      } else {
        expect(output).toContain("committed");
        expect(output).toContain("Publication check failed: connection closed");
        expect(output).toContain("openclaw id status");
        expect(output).toContain("Do not repeat");
      }
    },
  );

  it.each([true, false])(
    "reports committed follow-up failure without polling or retrying (json=%s)",
    async (json) => {
      followUpError = "restart failed";
      await expect(run("rebind", json)).resolves.toBeUndefined();
      expect(commits).toHaveLength(1);
      expect(process.exitCode).toBe(2);
      expect(
        vi.mocked(callGatewayFromCli).mock.calls.some(([method]) => method === "openclawId.people"),
      ).toBe(false);
      if (json) {
        expect(JSON.parse(output)).toEqual({
          moved: true,
          bindingSeq: 2,
          published: null,
          followUpError: "restart failed",
          nextStep: "openclaw id status",
        });
      } else {
        expect(output).toContain("committed");
        expect(output).toContain("Follow-up failed: restart failed");
        expect(output).toContain("openclaw id status");
        expect(output).toContain("Do not repeat rebind");
      }
    },
  );

  it("does not claim a move when the commit RPC is rejected", async () => {
    commitFailure = new Error("commit refused");
    await expect(run("rebind")).rejects.toThrow("commit refused");
    expect(commits).toHaveLength(0);
    expect(output).toBe("");
  });

  it("shows a rebind option refusal as an expected CLI error", async () => {
    await expect(run("rebind", false, ["--yes"])).rejects.toBeInstanceOf(ExpectedCliError);
  });

  it("treats a full command rerun as a new signed rotation, not a commit replay", async () => {
    await run("rebind");
    output = "";
    await run("rebind");
    expect(commits.map((binding) => binding.body.binding_seq)).toEqual([2, 3]);
    expect(new Set(commits.map((binding) => binding.body.k_srv)).size).toBe(2);
    expect(new Set(commits.map((binding) => binding.body.k_gw)).size).toBe(2);
    expect(JSON.parse(output)).toMatchObject({ moved: true, bindingSeq: 3 });
  });
});
