/**
 * Vitest Global Setup File
 *
 * Initializes determinism helpers for all browser-based UI tests.
 * This file is registered globally via vitest.config.ts setupFiles.
 */

import { beforeEach, afterEach } from "vitest";
import { applyDeterminismDefaults, resetDeterminismDefaults } from "../ui/test-helpers/determinism.js";

// Apply determinism defaults before each test
beforeEach(() => applyDeterminismDefaults());

// Reset determinism after each test to prevent state leakage
afterEach(() => resetDeterminismDefaults());
