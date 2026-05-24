import { describe, expect, it } from "vitest";
import {
  applyProductSurfaceCopy,
  resolveProductConfigureIntro,
  resolveProductDoctorIntro,
  resolveProductGatewayStatusIdentity,
  resolveProductStatusHeading,
  resolveProductTuiTitle,
} from "./product-surface.js";

describe("product-surface", () => {
  it("leaves strings unchanged outside product mode", () => {
    expect(applyProductSurfaceCopy("OpenClaw status", {})).toBe("OpenClaw status");
  });

  it("rewrites status and doctor headings", () => {
    const env = { CLAWORKS_PRODUCT: "1" };
    expect(resolveProductStatusHeading("status", env)).toBe("ClaWorks status");
    expect(resolveProductDoctorIntro(env)).toBe("ClaWorks doctor");
    expect(resolveProductConfigureIntro("configure", env)).toBe("ClaWorks configure");
    expect(resolveProductTuiTitle(env)).toBe("claworks tui");
  });

  it("resolves gateway status identity for each product", () => {
    const openclaw = resolveProductGatewayStatusIdentity({});
    expect(openclaw.id).toBe("openclaw");
    expect(openclaw.defaultPort).toBe(18789);
    expect(openclaw.launchAgentLabel).toBe("ai.openclaw.gateway");

    const claworks = resolveProductGatewayStatusIdentity({ CLAWORKS_PRODUCT: "1" });
    expect(claworks.id).toBe("claworks");
    expect(claworks.defaultPort).toBe(18800);
    expect(claworks.configPathHint).toBe("~/.claworks/claworks.json");
    expect(claworks.launchAgentLabel).toBe("ai.claworks.gateway");
  });

  it("rewrites CLI help descriptions", () => {
    expect(
      applyProductSurfaceCopy("Create and verify local backup archives for OpenClaw state", {
        CLAWORKS_PRODUCT: "1",
      }),
    ).toContain("ClaWorks state");
    expect(
      applyProductSurfaceCopy("Delete channel tokens/settings from openclaw.json", {
        CLAWORKS_PRODUCT: "1",
      }),
    ).toContain("claworks.json");
  });

  it("rewrites embedded openclaw command examples", () => {
    const env = { CLAWORKS_PRODUCT: "1" };
    expect(
      applyProductSurfaceCopy("Migration complete. Run `openclaw doctor` next.", env),
    ).toContain("`claworks doctor`");
    expect(applyProductSurfaceCopy("Command: openclaw channels status --probe", env)).toBe(
      "Command: claworks channels status --probe",
    );
    expect(
      applyProductSurfaceCopy(
        '"API Key" is sensitive. Set it via:\n  openclaw config set plugins.entries.foo.config.bar <value>',
        env,
      ),
    ).toContain("claworks config set");
    expect(applyProductSurfaceCopy("https://openclaw.ai/showcase", env)).toBe(
      "https://docs.claworks.ai/showcase",
    );
  });
});
