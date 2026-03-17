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
};
