import { describe, expect, it } from "vitest";
import { capCronJobToolsAllowOnCreate, planCronJobUpdatePatch } from "./cron-tool-creator-cap.js";

type CronJobUpdatePatchPlan = ReturnType<typeof planCronJobUpdatePatch>;

function readReadyPatch(plan: CronJobUpdatePatchPlan): Record<string, unknown> {
  expect(plan.kind).toBe("ready");
  if (plan.kind !== "ready") {
    throw new Error("expected a ready cron update patch");
  }
  return plan.patch;
}

describe("cron tool creator cap", () => {
  it("caps trigger-script creates without changing transport-only jobs", () => {
    const triggerJob = {
      trigger: { script: "return true" },
      payload: { kind: "systemEvent", text: "wake" },
    };
    const plainJob = {
      payload: { kind: "systemEvent", text: "wake" },
    };

    capCronJobToolsAllowOnCreate(triggerJob, ["read", "cron"]);
    capCronJobToolsAllowOnCreate(plainJob, ["read", "cron"]);

    // Legacy "cron" creator allowlists normalize to the canonical tool id.
    expect(triggerJob.payload).toEqual({
      kind: "systemEvent",
      text: "wake",
      toolsAllow: ["read", "automations"],
      toolsAllowIsDefault: true,
    });
    expect(plainJob.payload).toEqual({ kind: "systemEvent", text: "wake" });
  });

  it("caps explicit updates without loading the current job", () => {
    const input = {
      payload: { kind: "agentTurn", toolsAllow: ["read", "exec"] },
    };

    const patch = readReadyPatch(
      planCronJobUpdatePatch({
        patch: input,
        creatorToolAllowlist: ["read", "cron"],
      }),
    );

    expect(patch).toEqual({
      payload: { kind: "agentTurn", toolsAllow: ["read"] },
    });
    expect(input).toEqual({
      payload: { kind: "agentTurn", toolsAllow: ["read", "exec"] },
    });
  });

  it("preserves non-policy patches without loading or synthesizing authority", () => {
    expect(
      planCronJobUpdatePatch({
        patch: { enabled: false },
        creatorToolAllowlist: ["read", "cron"],
      }),
    ).toEqual({ kind: "ready", patch: { enabled: false } });
  });

  it("requests current state before deriving an implicit cap for a payload edit", () => {
    expect(
      planCronJobUpdatePatch({
        patch: { payload: { message: "updated" } },
        creatorToolAllowlist: ["read", "cron"],
      }),
    ).toEqual({ kind: "needs-current-job" });
  });

  it("leaves stored toolsAllow untouched on unrelated payload edits", () => {
    const narrower = readReadyPatch(
      planCronJobUpdatePatch({
        patch: { payload: { message: "updated" } },
        creatorToolAllowlist: ["read", "exec", "cron"],
        currentJob: {
          payload: { kind: "agentTurn", message: "work", toolsAllow: ["read"] },
        },
      }),
    );
    const storedDefault = readReadyPatch(
      planCronJobUpdatePatch({
        patch: { payload: { message: "updated" } },
        creatorToolAllowlist: ["read", "cron"],
        currentJob: {
          payload: {
            kind: "agentTurn",
            message: "work",
            toolsAllow: ["read"],
            toolsAllowIsDefault: true,
          },
        },
      }),
    );

    // Neither an explicit stored cap nor a default-stamped cap is echoed into
    // the unrelated patch: mergeCronPayload preserves the stored value, and
    // omitting toolsAllow keeps the cron service from treating the routine
    // edit as an explicit tool-authority mutation.
    expect(narrower).toEqual({
      payload: { kind: "agentTurn", message: "updated" },
    });
    expect(storedDefault).toEqual({
      payload: { kind: "agentTurn", message: "updated" },
    });
  });

  it("omits stored toolsAllow from unrelated payload edits so the service keeps the cap without reauthorizing", () => {
    const patch = readReadyPatch(
      planCronJobUpdatePatch({
        patch: { payload: { fallbacks: [] } },
        creatorToolAllowlist: ["message", "write", "read"],
        currentJob: {
          payload: {
            kind: "agentTurn",
            message: "work",
            toolsAllow: ["exec", "message", "write"],
          },
        },
      }),
    );

    // exec was granted by the operator (CLI) and the cron runtime executes it.
    // The patch must not echo it (that would read as an explicit authority
    // mutation) nor re-derive it through the incomplete creator snapshot.
    expect(patch).toEqual({
      payload: {
        kind: "agentTurn",
        fallbacks: [],
      },
    });
  });

  it("omits stored toolsAllow for script-trigger jobs on unrelated payload edits", () => {
    const patch = readReadyPatch(
      planCronJobUpdatePatch({
        patch: { payload: { model: "gpt-mini" } },
        creatorToolAllowlist: ["read"],
        currentJob: {
          trigger: { script: "return true" },
          payload: {
            kind: "script",
            script: "run()",
            toolsAllow: ["exec", "write"],
          },
        },
      }),
    );

    expect(patch).toEqual({
      payload: {
        kind: "script",
        model: "gpt-mini",
      },
    });
  });

  it("inherits kind for kind-less patches independently of creator policy", () => {
    const patch = { payload: { model: null } };
    expect(
      planCronJobUpdatePatch({
        patch,
        creatorToolAllowlist: undefined,
      }),
    ).toEqual({ kind: "needs-current-job" });

    expect(
      readReadyPatch(
        planCronJobUpdatePatch({
          patch,
          creatorToolAllowlist: undefined,
          currentJob: { payload: { kind: "agentTurn", message: "work" } },
        }),
      ),
    ).toEqual({ payload: { kind: "agentTurn", model: null } });
  });
});
