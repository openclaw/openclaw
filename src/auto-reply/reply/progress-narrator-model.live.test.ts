import { expect, it } from "vitest";
import { isLiveTestEnabled, readLiveTestConfig } from "../../agents/live-test-helpers.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  generateNarrationWithUtilityModel,
  prepareNarrationModel,
  type ProgressNarrationInput,
} from "./progress-narrator-model.js";

const live = isLiveTestEnabled() && process.env.OPENCLAW_LIVE_PROGRESS_NARRATION === "1";
const cases: { name: string; input: ProgressNarrationInput; blocked: boolean }[] = [
  {
    name: "references to earlier choices",
    input: {
      userMessage: "Do options 2 and 4 with the same constraints as before.",
      activityNotes: ["Tool read: project-notes.md"],
      previousText: "",
    },
    blocked: false,
  },
  {
    name: "an ordinary file review",
    input: {
      userMessage: "Review the project notes and check whether the proposed schedule is feasible.",
      activityNotes: ["Tool read: project-notes.md"],
      previousText: "",
    },
    blocked: false,
  },
  {
    name: "an explicit access blocker",
    input: {
      userMessage: "Review the project notes and check whether the proposed schedule is feasible.",
      activityNotes: [
        "Assistant: I cannot read the project notes because access is denied. I need access to continue.",
        "Read project-notes.md failed",
      ],
      previousText: "",
    },
    blocked: true,
  },
];

it.skipIf(!live).each(cases)(
  "grounds live narration for $name",
  { timeout: 90_000, retry: 0 },
  async ({ input, blocked }) => {
    const host = await readLiveTestConfig();
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const cfg: OpenClawConfig = {
        models: host.models,
        plugins: host.plugins,
        auth: host.auth,
        secrets: host.secrets,
        agents: {
          defaults: { ...host.agents?.defaults, workspace: state.workspaceDir },
          entries: {
            main: {
              ...host.agents?.entries?.main,
              agentDir: state.agentDir(),
              workspace: state.workspaceDir,
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const prepared = await prepareNarrationModel({ cfg, agentId: "main" });
      if (!prepared) {
        throw new Error("Live narration requires a configured utility model and runtime.");
      }
      const result = await generateNarrationWithUtilityModel({
        cfg,
        prepared,
        input,
        abortSignal: new AbortController().signal,
        timeoutMs: 60_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.text).toBeTruthy();
      const text = result.text ?? "";
      if (blocked) {
        expect(text).toMatch(/access|permission|denied|blocked/i);
      } else {
        expect(text).not.toMatch(
          /\b(?:please (?:share|provide|clarify)|(?:cannot|can't|can’t|don't|don’t|do not) (?:identify|know|understand|tell))\b/i,
        );
        expect(text).not.toMatch(
          /\b(?:cannot|can't|can’t) (?:access|read)\b|\b(?:don't|don’t|do not) have (?:access|the (?:contents|notes))\b/i,
        );
      }
    });
  },
);
