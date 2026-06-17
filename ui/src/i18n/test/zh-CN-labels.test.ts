// Content guard for issue #78038: zh-CN theme/cron labels and Dreaming restart modal.
// Asserts the real shipped zh-CN locale against the en source-of-truth so the
// reported mistranslations (and the copy-paste look-alikes) cannot regress.
import { describe, expect, it } from "vitest";
import { en } from "../locales/en.ts";
import { zh_CN } from "../locales/zh-CN.ts";

const HAN = /[一-鿿]/u;

describe("zh-CN translation accuracy (#78038)", () => {
  it("common.light is the theme color 浅色, not 浅睡 (light sleep)", () => {
    expect(zh_CN.common.light).toBe("浅色");
    // Must differ from the English source (no longer a copy of "Light").
    expect(zh_CN.common.light).not.toBe(en.common.light);
    // Must NOT have copied the (correct) Dreaming phase value "浅睡".
    expect(zh_CN.common.light).not.toBe(zh_CN.dreaming.phase.light);
  });

  it("cron job/field Name labels are 名称, not the person-name 姓名", () => {
    expect(zh_CN.cron.jobs.name).toBe("名称");
    expect(zh_CN.cron.form.fieldName).toBe("名称");
    expect(zh_CN.cron.jobs.name).not.toBe("姓名");
    expect(zh_CN.cron.form.fieldName).not.toBe("姓名");
  });

  it("all Dreaming restartConfirmation strings are translated (not left in English)", () => {
    const keys = ["title", "subtitle", "warning", "confirm", "restarting", "failed"] as const;
    for (const key of keys) {
      const value = zh_CN.dreaming.restartConfirmation[key];
      // No longer identical to the English source.
      expect(value, `restartConfirmation.${key} still equals English`).not.toBe(
        en.dreaming.restartConfirmation[key],
      );
      // Contains at least one Han character (genuinely translated).
      expect(HAN.test(value), `restartConfirmation.${key} has no Han chars`).toBe(true);
    }
  });
});
