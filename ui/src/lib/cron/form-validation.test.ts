// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { normalizeCronFormState, validateCronForm } from "./index.ts";

describe("cron form validation", () => {
  it.each([
    ["payloadKind", "isolated", "systemEvent", "main", "systemEvent"],
    ["payloadKind", "main", "agentTurn", "isolated", "agentTurn"],
    ["sessionTarget", "main", "agentTurn", "main", "systemEvent"],
    ["sessionTarget", "isolated", "systemEvent", "isolated", "agentTurn"],
  ] as const)(
    "normalizes a changed %s on %s/%s",
    (changed, sessionTarget, payloadKind, target, kind) => {
      const form = { ...DEFAULT_CRON_FORM, sessionTarget, payloadKind };
      expect(normalizeCronFormState(form, { [changed]: form[changed] })).toMatchObject({
        sessionTarget: target,
        payloadKind: kind,
        deliveryMode: "none",
      });
    },
  );

  it("validates key cron form errors", () => {
    const errors = validateCronForm({
      ...DEFAULT_CRON_FORM,
      name: "",
      scheduleKind: "cron",
      cronExpr: "",
      payloadKind: "agentTurn",
      payloadText: "",
      timeoutSeconds: "-1",
      triggerEnabled: true,
      triggerScript: "",
      deliveryMode: "webhook",
      deliveryTo: "ftp://bad",
    });
    expect(errors.name).toBe("cron.errors.nameRequired");
    expect(errors.cronExpr).toBe("cron.errors.cronExprRequired");
    expect(errors.payloadText).toBe("cron.errors.agentMessageRequired");
    expect(errors.triggerScript).toBe("cron.errors.triggerScriptRequired");
    expect(errors.timeoutSeconds).toBe("cron.errors.timeoutInvalid");
    expect(errors.deliveryTo).toBe("cron.errors.webhookUrlInvalid");
  });
});
