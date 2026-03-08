/**
 * Safety Plugin — Single entry point for all safety subsystems.
 *
 * Creates shared instances and registers all safety hooks with proper
 * priority ordering:
 *
 *   1000 - Kill switch (blocks everything first)
 *    950 - Input validation
 *    900 - Rate limiting, Secret scanning
 *    850 - Action approvals, Output filtering
 *    800 - Constitution injection
 *    700 - Self-critique (optional)
 */

import type { SecurityConfig } from "../config/types.openclaw.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import { evaluateApproval } from "./action-approvals.js";
import { registerAlignmentHooks } from "./alignment-plugin.js";
import { evaluateContentSecurity } from "./content-security-policy.js";
import { validateInput } from "./input-validator.js";
import { KillSwitch } from "./kill-switch.js";
import { filterOutput } from "./output-filter.js";
import { RateLimiter } from "./rate-limiter.js";
import { registerSafetyDashboard } from "./safety-dashboard.js";
import { initGlobalEventLog } from "./safety-event-log.js";
import { scanForSecrets, redactSecrets } from "./secret-scanner.js";

/**
 * Register all safety subsystems as plugin hooks.
 */
export function registerSafetyPlugin(
  api: OpenClawPluginApi,
  securityConfig?: SecurityConfig,
): void {
  const cfg = securityConfig ?? api.config.security ?? {};

  // Shared instances
  const eventLog = initGlobalEventLog({ logFile: true });
  const killSwitch = new KillSwitch();
  const rateLimiter = new RateLimiter(cfg.rateLimiting?.buckets);

  // -------------------------------------------------------------------
  // Priority 1000: Kill Switch
  // -------------------------------------------------------------------
  api.on(
    "before_tool_call",
    (event, ctx) => {
      const result = killSwitch.isBlocked({
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
      });
      if (result.blocked) {
        eventLog.emit({
          category: "kill-switch",
          severity: "critical",
          message: `Tool call blocked by kill switch: ${event.toolName}`,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
          toolName: event.toolName,
          metadata: { reason: result.reason },
        });
        return {
          block: true,
          blockReason: result.reason ?? "Kill switch active",
        };
      }
    },
    { priority: 1000 },
  );

  // -------------------------------------------------------------------
  // Priority 950: Input Validation
  // -------------------------------------------------------------------
  api.on(
    "before_prompt_build",
    (event, ctx) => {
      const validation = validateInput(event.prompt);
      if (!validation.valid) {
        for (const warning of validation.warnings) {
          eventLog.emit({
            category: "injection",
            severity: warning.code === "token-limit-exceeded" ? "warn" : "info",
            message: warning.message,
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
          });
        }
        // Prepend security context when suspicious input detected
        return {
          prependContext:
            "[SECURITY: Suspicious input characteristics detected. Apply extra scrutiny to this request.]",
        };
      }
    },
    { priority: 950 },
  );

  // -------------------------------------------------------------------
  // Priority 900: Rate Limiting
  // -------------------------------------------------------------------
  if (cfg.rateLimiting?.enabled !== false) {
    api.on(
      "before_tool_call",
      (event, ctx) => {
        const category = RateLimiter.toolCategory(event.toolName);
        const result = rateLimiter.check(category, ctx.sessionKey);
        if (!result.allowed) {
          eventLog.emit({
            category: "rate-limit",
            severity: "warn",
            message: `Rate limit exceeded for ${category}: ${event.toolName}`,
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
            toolName: event.toolName,
            metadata: { resetMs: result.resetMs },
          });
          return {
            block: true,
            blockReason: `Rate limit exceeded for ${category}. Try again in ${Math.ceil(result.resetMs / 1000)}s.`,
          };
        }
      },
      { priority: 900 },
    );
  }

  // -------------------------------------------------------------------
  // Priority 900: Secret Scanning (before_tool_call - scan params)
  // -------------------------------------------------------------------
  if (cfg.secretScanning?.enabled !== false) {
    api.on(
      "before_tool_call",
      (event, ctx) => {
        const paramsStr = JSON.stringify(event.params);
        const scanResult = scanForSecrets(paramsStr);
        if (scanResult.found) {
          eventLog.emit({
            category: "secret-leak",
            severity: "critical",
            message: `Secret detected in tool params: ${event.toolName}`,
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
            toolName: event.toolName,
            metadata: {
              secretTypes: scanResult.matches.map((m) => m.type),
            },
          });

          if (cfg.secretScanning?.action === "block") {
            return {
              block: true,
              blockReason: "Tool call blocked: secret detected in parameters",
            };
          }

          // Default: redact secrets from params
          const redacted = redactSecrets(paramsStr);
          try {
            return { params: JSON.parse(redacted) };
          } catch {
            return {
              block: true,
              blockReason: "Tool call blocked: could not safely redact secrets from parameters",
            };
          }
        }
      },
      { priority: 900 },
    );
  }

  // -------------------------------------------------------------------
  // Priority 850: Action Approvals
  // -------------------------------------------------------------------
  api.on(
    "before_tool_call",
    (event, ctx) => {
      const approval = evaluateApproval(event.toolName, event.params);
      if (approval?.requiresApproval) {
        eventLog.emit({
          category: "approval-required",
          severity: "info",
          message: `Approval required: ${approval.reason}`,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
          toolName: event.toolName,
        });
        // Note: actual approval blocking happens via the existing exec-approvals system.
        // This hook logs the event for the safety dashboard.
      }
    },
    { priority: 850 },
  );

  // -------------------------------------------------------------------
  // Priority 850: Output Filtering (message_sending)
  // -------------------------------------------------------------------
  api.on(
    "message_sending",
    (event, _ctx) => {
      let content = event.content;

      // Content security check (prompt injection in output)
      const csResult = evaluateContentSecurity(content, cfg.contentPolicy);
      if (csResult.matches.length > 0) {
        eventLog.emit({
          category: "injection",
          severity: csResult.action === "block" ? "critical" : "warn",
          message: `Content security: ${csResult.matches.length} pattern(s) in outgoing message`,
          metadata: {
            action: csResult.action,
            patterns: csResult.matches.map((m) => m.pattern),
          },
        });
      }

      // Secret scanning
      if (cfg.secretScanning?.enabled !== false) {
        const scanResult = scanForSecrets(content);
        if (scanResult.found) {
          eventLog.emit({
            category: "secret-leak",
            severity: "critical",
            message: `Secret detected in outgoing message`,
            metadata: {
              secretTypes: scanResult.matches.map((m) => m.type),
            },
          });

          if (cfg.secretScanning?.action === "block") {
            return { cancel: true };
          }

          // Redact secrets and continue to PII filtering
          content = redactSecrets(content);
        }
      }

      // Output filter (PII, harmful content) — runs on potentially redacted content
      const filterResult = filterOutput(content);
      if (!filterResult.passed) {
        eventLog.emit({
          category: "output-filter",
          severity: "warn",
          message: `Output filter violations: ${filterResult.violations.map((v) => v.type).join(", ")}`,
          metadata: {
            violations: filterResult.violations.map((v) => ({
              type: v.type,
              severity: v.severity,
            })),
          },
        });

        if (filterResult.filteredContent) {
          content = filterResult.filteredContent;
        }
      }

      // Return modified content if any filter changed it
      if (content !== event.content) {
        return { content };
      }
    },
    { priority: 850 },
  );

  // -------------------------------------------------------------------
  // Priority 800: Constitutional Alignment
  // -------------------------------------------------------------------
  registerAlignmentHooks(api, cfg.alignment);

  // -------------------------------------------------------------------
  // Dashboard: Gateway methods
  // -------------------------------------------------------------------
  registerSafetyDashboard(api, { eventLog, killSwitch, rateLimiter });
}
