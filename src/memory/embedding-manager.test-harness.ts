import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getEmbedBatchMock, resetEmbeddingMocks } from "./embedding.test-mocks.js";
import {
  getMemorySearchManager,
  type MemoryIndexManager,
  type MemorySearchManager,
} from "./index.js";

export function installEmbeddingManagerFixture(opts: {
  fixturePrefix: string;
  largeTokens: number;
  smallTokens: number;
  createCfg: (params: {
    workspaceDir: string;
    indexPath: string;
    tokens: number;
  }) => OpenClawConfig;
  resetIndexEachTest?: boolean;
}) {
  const embedBatch = getEmbedBatchMock();
  const resetIndexEachTest = opts.resetIndexEachTest ?? true;

  let fixtureRoot: string | undefined;
  let workspaceDir: string | undefined;
  let memoryDir: string | undefined;
  let managerLarge: MemoryIndexManager | undefined;
  let managerSmall: MemoryIndexManager | undefined;

  const resetManager = (manager: MemoryIndexManager) => {
    (manager as unknown as { resetIndex: () => void }).resetIndex();
    (manager as unknown as { dirty: boolean }).dirty = true;
  };

  const requireValue = <T>(value: T | undefined, name: string): T => {
    if (!value) {
      throw new Error(`${name} missing`);
    }
    return value;
  };

  const requireIndexManager = (
    manager: MemorySearchManager | null,
    name: string,
  ): MemoryIndexManager => {
    if (!manager) {
      throw new Error(`${name} missing`);
    }
    if (!("resetIndex" in manager) || typeof manager.resetIndex !== "function") {
      throw new Error(`${name} is not a MemoryIndexManager`);
    }
    return manager as unknown as MemoryIndexManager;
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), opts.fixturePrefix));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    const indexPathLarge = path.join(fixtureRoot, "index.large.sqlite");
    const indexPathSmall = path.join(fixtureRoot, "index.small.sqlite");

    const large = await getMemorySearchManager({
      cfg: opts.createCfg({
        workspaceDir,
        indexPath: indexPathLarge,
        tokens: opts.largeTokens,
      }),
      agentId: "main",
    });
    expect(large.manager).not.toBeNull();
    managerLarge = requireIndexManager(large.manager, "managerLarge");

    const small = await getMemorySearchManager({
      cfg: opts.createCfg({
        workspaceDir,
        indexPath: indexPathSmall,
        tokens: opts.smallTokens,
      }),
      agentId: "main",
    });
    expect(small.manager).not.toBeNull();
    managerSmall = requireIndexManager(small.manager, "managerSmall");
  });

  afterAll(async () => {
    if (managerLarge) {
      await managerLarge.close();
      managerLarge = undefined;
    }
    if (managerSmall) {
      await managerSmall.close();
      managerSmall = undefined;
    }
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = undefined;
    }
  });

  beforeEach(async () => {
    resetEmbeddingMocks();

    const dir = requireValue(memoryDir, "memoryDir");
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });

    if (resetIndexEachTest) {
      resetManager(requireValue(managerLarge, "managerLarge"));
      resetManager(requireValue(managerSmall, "managerSmall"));
    }
  });

  return {
    embedBatch,
    getFixtureRoot: () => requireValue(fixtureRoot, "fixtureRoot"),
    getWorkspaceDir: () => requireValue(workspaceDir, "workspaceDir"),
    getMemoryDir: () => requireValue(memoryDir, "memoryDir"),
    getManagerLarge: () => requireValue(managerLarge, "managerLarge"),
    getManagerSmall: () => requireValue(managerSmall, "managerSmall"),
    resetManager,
  };
}
