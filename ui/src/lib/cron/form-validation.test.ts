// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { normalizeCronFormState, validateCronForm } from "./index.ts";

describe("cron form validation", () => {
  it.each([
    ["payloadKind", "isolated", "systemEvent", "main", "systemEvent"],
    ["payloadKind", "main", "agentTurn", "main", "agentTurn"],
    ["sessionTarget", "main", "agentTurn", "main", "agentTurn"],
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

  it.each([
    ["main", "agentTurn", false, "announce"],
    ["main", "systemEvent", false, "none"],
    ["main", "script", true, "none"],
    ["main", "command", true, "none"],
    ["isolated", "script", true, "announce"],
    ["isolated", "command", true, "announce"],
  ] as const)(
    "normalizes announce delivery for %s/%s",
    (sessionTarget, payloadKind, payloadLocked, deliveryMode) => {
      expect(
        normalizeCronFormState({
          ...DEFAULT_CRON_FORM,
          sessionTarget,
          payloadKind,
          payloadLocked,
          deliveryMode: "announce",
        }).deliveryMode,
      ).toBe(deliveryMode);
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
      activeHoursEnabled: true,
      activeHoursStart: "24:00",
      activeHoursEnd: "25:00",
      activeHoursTimezone: "Invalid/Timezone",
    });
    expect(errors.name).toBe("cron.errors.nameRequired");
    expect(errors.cronExpr).toBe("cron.errors.cronExprRequired");
    expect(errors.payloadText).toBe("cron.errors.agentMessageRequired");
    expect(errors.triggerScript).toBe("cron.errors.triggerScriptRequired");
    expect(errors.timeoutSeconds).toBe("cron.errors.timeoutInvalid");
    expect(errors.deliveryTo).toBe("cron.errors.webhookUrlInvalid");
    expect(errors.activeHoursStart).toBe("cron.errors.activeHoursTime");
    expect(errors.activeHoursEnd).toBe("cron.errors.activeHoursTime");
    expect(errors.activeHoursTimezone).toBe("cron.errors.activeHoursTimezone");
  });

  it("preserves an explicit direct-message block and a valid overnight window", () => {
    const form = {
      ...DEFAULT_CRON_FORM,
      name: "Daily check",
      payloadText: "Check notes",
      deliveryMode: "announce" as const,
      deliveryTarget: "owner" as const,
      deliveryDirectPolicy: "block" as const,
      activeHoursEnabled: true,
      activeHoursStart: "22:00",
      activeHoursEnd: "24:00",
      activeHoursTimezone: "user",
    };
    expect(validateCronForm(form)).toEqual({});
    expect(validateCronForm({ ...form, deliveryDirectPolicy: "allow" })).toEqual({});
  });
});
