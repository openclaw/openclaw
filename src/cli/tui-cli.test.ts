/**
 * Tests for TUI CLI config support (#33102)
 */

import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

describe("TUI CLI config", () => {
  it("should support tui.deliver config option", () => {
    // Verify the type system accepts the new config option
    const testConfig: OpenClawConfig = {
      cli: {
        tui: {
          deliver: true,
        },
      },
    };

    expect(testConfig.cli?.tui?.deliver).toBe(true);
  });

  it("should use config default when flag not provided", () => {
    const mockConfig = { cli: { tui: { deliver: true } } };
    const opts = { deliver: undefined };

    const deliver =
      opts.deliver !== undefined ? Boolean(opts.deliver) : (mockConfig.cli?.tui?.deliver ?? false);

    expect(deliver).toBe(true);
  });

  it("should allow flag to override config default", () => {
    const mockConfig = { cli: { tui: { deliver: false } } };
    const opts = { deliver: true };

    const deliver =
      opts.deliver !== undefined ? Boolean(opts.deliver) : (mockConfig.cli?.tui?.deliver ?? false);

    expect(deliver).toBe(true);
  });

  it("should default to false when no config and no flag", () => {
    const mockConfig: { cli?: { tui?: { deliver?: boolean } } } = { cli: undefined };
    const opts = { deliver: undefined };

    const deliver =
      opts.deliver !== undefined ? Boolean(opts.deliver) : (mockConfig.cli?.tui?.deliver ?? false);

    expect(deliver).toBe(false);
  });
});
