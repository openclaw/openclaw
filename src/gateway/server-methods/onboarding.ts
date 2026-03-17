import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getOnboardingState,
  upsertOnboardingState,
  markOnboardingComplete,
  markOnboardingSkipped,
  resetOnboardingState,
  stripConfigSecrets,
} from "../../infra/state-db/onboarding-sqlite.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  validateOnboardingUpdateParams,
  validateOnboardingValidatePathParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const onboardingHandlers: GatewayRequestHandlers = {
  "onboarding.status": ({ respond }) => {
    try {
      const state = getOnboardingState();
      respond(true, {
        status: state.status,
        currentStep: state.currentStep,
        stepsCompleted: state.stepsCompleted,
        stepsSkipped: state.stepsSkipped,
        configSnapshot: stripConfigSecrets(state.configSnapshot),
        startedAt: state.startedAt,
        completedAt: state.completedAt,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          `Failed to get onboarding status: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },

  "onboarding.update": ({ params, respond }) => {
    if (!assertValidParams(params, validateOnboardingUpdateParams, "onboarding.update", respond)) {
      return;
    }
    try {
      const state = upsertOnboardingState({
        status: "in_progress",
        currentStep: params.currentStep,
        stepsCompleted: params.stepsCompleted,
        stepsSkipped: params.stepsSkipped,
        configSnapshot: params.configSnapshot as Record<string, unknown> | undefined,
      });
      respond(true, {
        status: state.status,
        currentStep: state.currentStep,
        stepsCompleted: state.stepsCompleted,
        stepsSkipped: state.stepsSkipped,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          `Failed to update onboarding: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },

  "onboarding.complete": ({ respond }) => {
    try {
      const state = markOnboardingComplete();
      respond(true, { status: state.status, completedAt: state.completedAt });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          `Failed to complete onboarding: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },

  "onboarding.skip": ({ respond }) => {
    try {
      const state = markOnboardingSkipped();
      respond(true, { status: state.status, completedAt: state.completedAt });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          `Failed to skip onboarding: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },

  "onboarding.reset": ({ respond }) => {
    try {
      const state = resetOnboardingState();
      respond(true, { status: state.status, currentStep: state.currentStep });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          `Failed to reset onboarding: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },

  "onboarding.validatePath": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateOnboardingValidatePathParams,
        "onboarding.validatePath",
        respond,
      )
    ) {
      return;
    }
    try {
      const expandedPath = params.path.startsWith("~/")
        ? path.join(os.homedir(), params.path.slice(2))
        : params.path;
      const resolvedPath = path.resolve(expandedPath);
      const exists = fs.existsSync(resolvedPath);
      let isDirectory = false;
      let writable = false;

      if (exists) {
        const stat = fs.statSync(resolvedPath);
        isDirectory = stat.isDirectory();
        if (isDirectory) {
          try {
            fs.accessSync(resolvedPath, fs.constants.W_OK);
            writable = true;
          } catch {
            writable = false;
          }
        }
      } else {
        // Check if parent exists and is writable (can create the dir)
        const parent = path.dirname(resolvedPath);
        if (fs.existsSync(parent)) {
          try {
            fs.accessSync(parent, fs.constants.W_OK);
            writable = true;
            isDirectory = true; // Will be created as a directory
          } catch {
            writable = false;
          }
        }
      }

      respond(true, {
        path: resolvedPath,
        exists,
        isDirectory,
        writable,
        valid: isDirectory && writable,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          `Failed to validate path: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },

  "onboarding.healthCheck": async ({ respond, context }) => {
    type CheckItem = {
      id: string;
      label: string;
      status: "pass" | "fail" | "warn";
      detail?: string;
    };
    const checks: CheckItem[] = [];

    // 1. Gateway responding
    try {
      const health = context.getHealthCache();
      checks.push({
        id: "gateway",
        label: "Gateway",
        status: health ? "pass" : "warn",
        detail: health ? "Running" : "Health cache empty",
      });
    } catch {
      checks.push({
        id: "gateway",
        label: "Gateway",
        status: "pass",
        detail: "Responding to RPCs",
      });
    }

    // 2. AI provider / model reachable
    try {
      const catalog = await context.loadGatewayModelCatalog();
      if (catalog.length > 0) {
        checks.push({
          id: "provider",
          label: "AI Provider",
          status: "pass",
          detail: `${catalog.length} model${catalog.length !== 1 ? "s" : ""} available`,
        });
      } else {
        checks.push({
          id: "provider",
          label: "AI Provider",
          status: "fail",
          detail: "No models found",
        });
      }
    } catch (err) {
      checks.push({
        id: "provider",
        label: "AI Provider",
        status: "fail",
        detail: err instanceof Error ? err.message : "Failed to load models",
      });
    }

    // 3. Channels configured
    try {
      const snapshot = context.getRuntimeSnapshot();
      const channelIds = Object.keys(snapshot.channels ?? {});
      const runningCount = channelIds.filter((id) => {
        const ch = snapshot.channels[id];
        return ch && (ch as { running?: boolean }).running;
      }).length;
      if (channelIds.length > 0) {
        checks.push({
          id: "channels",
          label: "Channels",
          status: runningCount > 0 ? "pass" : "warn",
          detail: `${runningCount} running of ${channelIds.length} configured`,
        });
      } else {
        checks.push({
          id: "channels",
          label: "Channels",
          status: "warn",
          detail: "No channels configured",
        });
      }
    } catch {
      checks.push({
        id: "channels",
        label: "Channels",
        status: "warn",
        detail: "Could not check channels",
      });
    }

    // 4. Config valid
    try {
      const state = getOnboardingState();
      checks.push({
        id: "onboarding",
        label: "Onboarding",
        status:
          state.status === "completed" ? "pass" : state.status === "skipped" ? "warn" : "warn",
        detail:
          state.status === "completed"
            ? "Completed"
            : state.status === "skipped"
              ? "Skipped"
              : "Incomplete",
      });
    } catch {
      checks.push({
        id: "onboarding",
        label: "Onboarding",
        status: "warn",
        detail: "Could not check status",
      });
    }

    const allPass = checks.every((c) => c.status === "pass");
    const hasFailure = checks.some((c) => c.status === "fail");
    respond(true, {
      healthy: allPass,
      status: hasFailure ? "unhealthy" : allPass ? "healthy" : "degraded",
      checks,
    });
  },
};
