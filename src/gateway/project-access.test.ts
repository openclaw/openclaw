import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  INTERNAL_PROJECT_REQUESTER,
  canRequesterUseProject,
  filterProjectsForRequester,
  operatorProjectRequester,
  resetProjectVisibilityCacheForTest,
  resolveRunProjectRequester,
} from "./project-access.js";

const cfg = {} as OpenClawConfig;
const guest = operatorProjectRequester(["operator.sessions.write"]);
const contributor = operatorProjectRequester(["operator.read", "operator.sessions.write"]);
const maintainer = operatorProjectRequester(["operator.write"]);

function project(name: string) {
  return { source: "registered" as const, originUrl: `https://github.com/openclaw/${name}.git` };
}

function visibilityFetch(visibility: Record<string, string | number>) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const name = new URL(url).pathname.split("/").at(-1) ?? "";
    const answer = visibility[name];
    if (typeof answer === "number") {
      return new Response(JSON.stringify({ message: "error" }), {
        status: answer,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ full_name: `openclaw/${name}`, visibility: answer }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("project access", () => {
  beforeEach(() => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    setRuntimeConfigSnapshot(cfg);
    resetProjectVisibilityCacheForTest();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearRuntimeConfigSnapshot();
  });

  it("limits restricted roles to public GitHub repositories and agent workspaces", async () => {
    const fetchImpl = visibilityFetch({
      site: "public",
      openclaworg: "private",
      handbook: "internal",
      gone: 404,
    });
    const projects = [
      project("site"),
      project("openclaworg"),
      project("handbook"),
      project("gone"),
      { source: "registered" as const, originUrl: "https://gitlab.com/openclaw/site.git" },
      { source: "registered" as const },
      { source: "workspace" as const },
    ];

    await expect(filterProjectsForRequester(cfg, projects, guest, { fetchImpl })).resolves.toEqual([
      project("site"),
      { source: "workspace" },
    ]);
    await expect(
      filterProjectsForRequester(cfg, projects, contributor, { fetchImpl }),
    ).resolves.toEqual([project("site"), { source: "workspace" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    fetchImpl.mockClear();
    await expect(
      filterProjectsForRequester(cfg, projects, maintainer, { fetchImpl }),
    ).resolves.toEqual(projects);
    await expect(
      canRequesterUseProject(cfg, project("openclaworg"), INTERNAL_PROJECT_REQUESTER, {
        fetchImpl,
      }),
    ).resolves.toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("binds background runs to the creator's live role", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("guest@example.test");
      const catalog = await prepareUserProfileCatalog();
      using _ = { [Symbol.dispose]: catalog.release };
      const roles = {
        default: "guest",
        definitions: {
          guest: {
            scopes: ["operator.sessions.write"],
            sessions: { others: "view" },
            agents: ["main"],
          },
        },
      };
      const roleCfg = { gateway: { roles } } as OpenClawConfig;
      expect(resolveRunProjectRequester(roleCfg, { profileId: profile.id })).toMatchObject(guest);
      // The admitted operator's effective scopes (membership caps included) win over roles.
      expect(
        resolveRunProjectRequester(cfg, {
          profileId: profile.id,
          operatorScopes: ["operator.sessions.write"],
        }),
      ).toMatchObject(guest);
      // Owner, cron and unlinked runs carry no role and stay Gateway-internal.
      expect(resolveRunProjectRequester(roleCfg, {})).toBe(INTERNAL_PROJECT_REQUESTER);
      expect(resolveRunProjectRequester(cfg, { profileId: profile.id })).toBe(
        INTERNAL_PROJECT_REQUESTER,
      );
    });
  });

  it("caches answers for discovery, rechecks fresh handoffs and never caches failures", async () => {
    const visibility: Record<string, string | number> = { site: "public", flaky: 403 };
    const fetchImpl = visibilityFetch(visibility);

    await expect(canRequesterUseProject(cfg, project("site"), guest, { fetchImpl })).resolves.toBe(
      true,
    );
    visibility.site = "private";
    // Discovery may lag a public-to-private change by the TTL...
    await expect(canRequesterUseProject(cfg, project("site"), guest, { fetchImpl })).resolves.toBe(
      true,
    );
    // ...but handing out source asks GitHub again.
    await expect(
      canRequesterUseProject(cfg, project("site"), guest, { fetchImpl, fresh: true }),
    ).resolves.toBe(false);
    await expect(canRequesterUseProject(cfg, project("site"), guest, { fetchImpl })).resolves.toBe(
      false,
    );

    // A rate-limited or failed lookup denies and is retried next time.
    await expect(canRequesterUseProject(cfg, project("flaky"), guest, { fetchImpl })).resolves.toBe(
      false,
    );
    visibility.flaky = "public";
    await expect(canRequesterUseProject(cfg, project("flaky"), guest, { fetchImpl })).resolves.toBe(
      true,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
