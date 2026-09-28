import fs from "node:fs/promises";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type {
  SkillsProposalCreateParams,
  SkillsProposalUpdateParams,
  SkillsProposalReviseParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasErrnoCode } from "../../infra/errno.js";
import * as fsSafe from "../../infra/fs-safe.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as generation from "../../skills/workshop/proposal-generation.js";
import { proposeCreateSkill } from "../../skills/workshop/service-propose.js";
import { inspectSkillProposal } from "../../skills/workshop/service-query.js";
import { resolveWorkshopSkillsDir } from "../../skills/workshop/skills-root.js";
import { executeSkillWorkshopOperation } from "../../skills/workshop/store-client.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayClient } from "./client-types.js";

const supportFile = { path: "references/client.txt", content: "Client supplied support bytes.\n" };
const supportFiles = [supportFile];
const disabledError = { code: "FORBIDDEN", details: { code: "UPLOADS_DISABLED" } };
const client: GatewayClient = {
  connect: {
    minProtocol: 1,
    maxProtocol: 1,
    role: "operator",
    scopes: ["operator.admin"],
    client: { id: "test", mode: "test", platform: "test", version: "1" },
  },
};
let state: OpenClawTestState;
let config: OpenClawConfig;
let serial = 0;
const methods = ["create", "update", "revise"] as const;
const context = createDirectChatContext({
  getRuntimeConfig: () => config,
  getCommittedRuntimeConfig: () => config,
});
function setUploads(enabled?: boolean) {
  config = {
    agents: { entries: { main: { workspace: state.workspaceDir } } },
    gateway: { uploads: { enabled } },
  };
}
async function dispatch(method: string, params: Record<string, unknown>, caller = client) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: String(++serial), method, params },
    client: caller,
    context,
    isWebchatConnect: () => false,
    respond,
  });
  return respond;
}
async function persisted() {
  const proposals = await executeSkillWorkshopOperation(
    "workshop.proposals.list",
    { agentId: "main" },
    { config, agentId: "main" },
  );
  const dir = state.statePath("skill-workshop", "proposals");
  const entries = await fs
    .readdir(dir, { recursive: true, withFileTypes: true })
    .catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry): Promise<[string, string]> => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(dir, file), await fs.readFile(file, "utf8")];
      }),
  );
  return { proposals, files: files.toSorted((a, b) => a[0].localeCompare(b[0])) };
}
async function prepare(
  kind: (typeof methods)[number],
  files: typeof supportFiles | undefined = supportFiles,
) {
  const name = "upload-proof-" + ++serial;
  if (kind === "create") {
    const params: SkillsProposalCreateParams = {
      agentId: "main",
      name,
      description: "Upload proof",
      content: "# Upload proof\n",
      supportFiles: files,
    };
    return { method: "skills.proposals.create", params };
  }
  if (kind === "update") {
    const target = path.join(resolveWorkshopSkillsDir(config, "main"), name);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(
      path.join(target, "SKILL.md"),
      "---\nname: " + name + "\ndescription: Upload proof\n---\n# Original skill\n",
    );
    const params: SkillsProposalUpdateParams = {
      agentId: "main",
      skillName: name,
      content: "# Updated proof\n",
      supportFiles: files,
    };
    return { method: "skills.proposals.update", params };
  }
  const seed = await proposeCreateSkill({
    config,
    agentId: "main",
    workspaceDir: state.workspaceDir,
    name,
    description: "Upload proof",
    content: "# Original proposal\n",
    supportFiles: [{ path: "references/existing.txt", content: "Existing server bytes.\n" }],
  });
  const params: SkillsProposalReviseParams = {
    agentId: "main",
    proposalId: seed.record.id,
    expectedRevisionHash: seed.revisionHash,
    content: "# Revised proof\n",
    supportFiles: files,
  };
  return { method: "skills.proposals.revise", params };
}

beforeAll(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-proposal-uploads-",
  });
  setUploads();
});
afterAll(async () => {
  await state.cleanup();
});
beforeEach(() => {
  setUploads();
});

describe("proposal upload policy through production Gateway dispatch and storage", () => {
  it.each(methods)("persists %s support bytes by default and explicitly enabled", async (kind) => {
    for (const enabled of [undefined, true]) {
      setUploads(enabled);
      const request = await prepare(kind);
      const before = await persisted();
      expect(await dispatch(request.method, request.params)).toHaveBeenCalledWith(
        true,
        expect.anything(),
        undefined,
      );
      const stored = await persisted();
      expect(
        stored.files.some(
          ([file, content]) =>
            !before.files.some(([old]) => old === file) &&
            file.endsWith("/references/client.txt") &&
            content === supportFile.content,
        ),
      ).toBe(true);
    }
  });
  it.each(methods)(
    "rejects disabled %s without writing a proposal or support bytes",
    async (kind) => {
      const request = await prepare(kind);
      const before = await persisted();
      setUploads(false);
      expect
        .soft(await dispatch(request.method, request.params))
        .toHaveBeenCalledWith(false, undefined, expect.objectContaining(disabledError));
      expect(await persisted()).toEqual(before);
    },
  );

  it.each(methods)(
    "rechecks %s after async filesystem preparation before writing bytes",
    async (kind) => {
      const request = await prepare(kind);
      const before = await persisted();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const stage = generation.stageSkillProposalGeneration;
      const root = fsSafe.root;
      const createSpies: MockInstance<fsSafe.Root["create"]>[] = [];
      let staging = false;
      using stageSpy = vi
        .spyOn(generation, "stageSkillProposalGeneration")
        .mockImplementation(async (params) => {
          staging = true;
          return stage(params);
        });
      using rootSpy = vi.spyOn(fsSafe, "root").mockImplementation(async (dir, defaults) => {
        const result = await root(dir, defaults);
        if (staging && dir === state.stateDir) {
          createSpies.push(vi.spyOn(result, "create"));
          entered.resolve();
          await release.promise;
        }
        return result;
      });
      const pending = dispatch(request.method, request.params);
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Request completed before filesystem preparation");
          }),
        ]);
        setUploads(false);
        release.resolve();
        expect
          .soft(await pending)
          .toHaveBeenCalledWith(false, undefined, expect.objectContaining(disabledError));
        expect(stageSpy).toHaveBeenCalledOnce();
        expect(rootSpy).toHaveBeenCalled();
        // A later SQLite refusal and cleanup must not conceal an earlier file write.
        expect(createSpies.length).toBeGreaterThan(0);
        for (const createFile of createSpies) {
          expect(createFile).not.toHaveBeenCalled();
        }
        expect(await persisted()).toEqual(before);
      } finally {
        release.resolve();
        await pending;
        for (const createFile of createSpies) {
          createFile.mockRestore();
        }
      }
    },
  );
  it.each(methods)(
    "refuses %s metadata commit and cleans staged bytes after hot disable",
    async (kind) => {
      const request = await prepare(kind);
      const before = await persisted();
      const stage = generation.stageSkillProposalGeneration;
      let staged = false;
      let commitRequested = false;
      const admit = workerAdmission.createSqliteWorkerOperationAdmission;
      using commit = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((assertCurrent, attachment) =>
          admit((admission, grant) => {
            if (staged && admission.stage === "commit" && !commitRequested) {
              commitRequested = true;
              setUploads(false);
            }
            assertCurrent(admission, grant);
          }, attachment),
        );
      using staging = vi
        .spyOn(generation, "stageSkillProposalGeneration")
        .mockImplementation(async (params) => {
          await stage(params);
          staged = true;
        });
      expect
        .soft(await dispatch(request.method, request.params))
        .toHaveBeenCalledWith(false, undefined, expect.objectContaining(disabledError));
      expect(staging).toHaveBeenCalledOnce();
      expect(commit).toHaveBeenCalled();
      expect(commitRequested).toBe(true);
      expect(await persisted()).toEqual(before);
    },
  );
  it.each(methods)("preserves text-only %s while disabled", async (kind) => {
    const request = await prepare(kind);
    delete request.params.supportFiles;
    setUploads(false);
    expect(await dispatch(request.method, request.params)).toHaveBeenCalledWith(
      true,
      expect.anything(),
      undefined,
    );
    if ("proposalId" in request.params) {
      const stored = await inspectSkillProposal(request.params.proposalId, {
        config,
        agentId: "main",
      });
      expect(stored?.content).toContain("# Revised proof");
      expect(stored?.supportFiles).toEqual([
        expect.objectContaining({
          path: "references/existing.txt",
          content: "Existing server bytes.\n",
        }),
      ]);
    }
  });
  it.each(methods)("ignores spoofed internal flags in %s payloads", async (kind) => {
    const request = await prepare(kind);
    const before = await persisted();
    setUploads(false);
    expect(
      await dispatch(request.method, {
        ...request.params,
        internal: { syntheticClient: true, agentRuntimeIdentity: {} },
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining(disabledError));
    expect(await persisted()).toEqual(before);
  });
  it("preserves trusted synthetic ingress and service-agent support files while disabled", async () => {
    setUploads(false);
    const request = await prepare("create");
    expect(
      await dispatch(request.method, request.params, {
        ...client,
        internal: { syntheticClient: true },
      }),
    ).toHaveBeenCalledWith(true, expect.anything(), undefined);
    // Service-agent calls have no Gateway client policy; the same storage owner remains usable.
    const service = await proposeCreateSkill({
      config,
      agentId: "main",
      workspaceDir: state.workspaceDir,
      name: "service-proof",
      description: "Service agent proof",
      content: "# Internal service\n",
      supportFiles,
    });
    const stored = await inspectSkillProposal(service.record.id, { config, agentId: "main" });
    expect(stored?.supportFiles).toEqual([expect.objectContaining(supportFile)]);
  });
});
