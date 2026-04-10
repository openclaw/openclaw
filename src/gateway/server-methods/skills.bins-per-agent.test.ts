import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeSkill } from "../../agents/skills.e2e-test-helpers.js";
import { loadWorkspaceSkillEntries } from "../../agents/skills.js";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { validateSkillsBinsParams } from "../protocol/index.js";
import { collectSkillBins } from "./skills.js";

/*
 * These tests pin the per-agent behavior of the `skills.bins` gateway RPC.
 *
 * The RPC drives the `autoAllowSkills` feature of exec approvals: any bin
 * returned here gets an implicit exec allowlist entry on the node host. Before
 * this PR the handler unioned bins across every agent workspace, which meant
 * a skill living only in agent A's workspace still auto-allowed its bin for
 * exec calls originating from agent B. That broke the mental model implied by
 * the skills UI (skills are visibly scoped to a specific agent or to global),
 * and made it impossible to "demote" a sensitive skill to a single agent.
 *
 * Now the handler accepts an `agentId` parameter and returns only the bins
 * declared by skills that agent can actually see, via `loadWorkspaceSkillEntries`
 * (which applies the same tag / filter resolution the UI uses). We exercise
 * the pure helper plus the schema validator here; the wired handler is
 * exercised indirectly by the existing gateway integration tests.
 */

const fixtureSuite = createFixtureSuite("openclaw-skills-bins-per-agent-");
let tempHome: TempHomeEnv | null = null;

const binsMetadata = (bins: string[]) =>
  `{ openclaw: { requires: { bins: ${JSON.stringify(bins)} } } }`;

beforeAll(async () => {
  await fixtureSuite.setup();
  tempHome = await createTempHomeEnv("ocplatform-skills-bins-per-agent-home-");
});

afterAll(async () => {
  if (tempHome) {
    await tempHome.restore();
    tempHome = null;
  }
  await fixtureSuite.cleanup();
});

describe("skills.bins schema", () => {
  it("accepts an optional agentId", () => {
    expect(validateSkillsBinsParams({})).toBe(true);
    expect(validateSkillsBinsParams({ agentId: "main" })).toBe(true);
    expect(validateSkillsBinsParams({ agentId: "gabe" })).toBe(true);
  });

  it("rejects unknown properties and empty agentId", () => {
    expect(validateSkillsBinsParams({ agentId: "" })).toBe(false);
    expect(validateSkillsBinsParams({ agentId: "main", unknown: 1 })).toBe(false);
  });
});

describe("collectSkillBins + loadWorkspaceSkillEntries (per-agent)", () => {
  it("returns only the bins declared by skills in a given agent's workspace", async () => {
    const joeyWorkspace = await fixtureSuite.createCaseDir("joey-workspace");
    const gabeWorkspace = await fixtureSuite.createCaseDir("gabe-workspace");

    await writeSkill({
      dir: path.join(joeyWorkspace, "skills", "gog"),
      name: "gog",
      description: "Google Workspace CLI",
      metadata: binsMetadata(["gog"]),
    });
    await writeSkill({
      dir: path.join(joeyWorkspace, "skills", "listing-search"),
      name: "listing-search",
      description: "Listing search helper",
      metadata: binsMetadata(["listing-search"]),
    });
    await writeSkill({
      dir: path.join(gabeWorkspace, "skills", "claude-auth"),
      name: "claude-auth",
      description: "Refresh Claude credentials",
      metadata: binsMetadata(["claude", "tmux"]),
    });

    const joeyBins = collectSkillBins(
      loadWorkspaceSkillEntries(joeyWorkspace, { agentId: "joey" }),
    );
    const gabeBins = collectSkillBins(
      loadWorkspaceSkillEntries(gabeWorkspace, { agentId: "gabe" }),
    );

    expect(joeyBins.toSorted()).toEqual(["gog", "listing-search"]);
    expect(gabeBins.toSorted()).toEqual(["claude", "tmux"]);

    // No leakage: gabe must not see gog, joey must not see tmux/claude.
    expect(gabeBins).not.toContain("gog");
    expect(gabeBins).not.toContain("listing-search");
    expect(joeyBins).not.toContain("claude");
    expect(joeyBins).not.toContain("tmux");
  });

  it("returns an empty list for an agent whose workspace has no skill bins", async () => {
    const emptyWorkspace = await fixtureSuite.createCaseDir("empty-workspace");
    await writeSkill({
      dir: path.join(emptyWorkspace, "skills", "docs-only"),
      name: "docs-only",
      description: "A doc-only skill with no bin requirements",
    });

    const bins = collectSkillBins(
      loadWorkspaceSkillEntries(emptyWorkspace, { agentId: "docs" }),
    );
    expect(bins).toEqual([]);
  });
});
