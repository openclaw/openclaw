import {
  handlePatternsGet,
  handlePatternsPut,
  handlePatternsTest,
} from "../gateway/iris-patterns-api.js";
import { handlePatternsUi } from "../gateway/iris-patterns-ui.js";
import {
  messageLoggerReceivedHandler,
  messageLoggerSentHandler,
  messageLoggerTranscribedHandler,
} from "../hooks/bundled/message-logger/handler.js";
import { patternDetectorHandler } from "../hooks/bundled/pattern-detector/handler.js";
import type { PluginRegistry } from "./registry.js";
import type { PluginHookRegistration } from "./types.js";

export function registerIrisBuiltinHooks(registry: PluginRegistry): void {
  // Pattern Detector: before_agent_start
  registry.typedHooks.push({
    pluginId: "iris:pattern-detector",
    hookName: "before_agent_start",
    handler: patternDetectorHandler,
    priority: 10,
    source: "iris-builtin",
  } as PluginHookRegistration);

  // Message Logger: message_received
  registry.typedHooks.push({
    pluginId: "iris:message-logger",
    hookName: "message_received",
    handler: messageLoggerReceivedHandler,
    priority: 0,
    source: "iris-builtin",
  } as PluginHookRegistration);

  // Message Logger: message_sent
  registry.typedHooks.push({
    pluginId: "iris:message-logger",
    hookName: "message_sent",
    handler: messageLoggerSentHandler,
    priority: 0,
    source: "iris-builtin",
  } as PluginHookRegistration);

  // Message Logger: message_transcribed
  registry.typedHooks.push({
    pluginId: "iris:message-logger",
    hookName: "message_transcribed",
    handler: messageLoggerTranscribedHandler,
    priority: 0,
    source: "iris-builtin",
  } as PluginHookRegistration);

  // HTTP routes for Pattern Detector UI
  registerPatternDetectorRoutes(registry);
}

function registerPatternDetectorRoutes(registry: PluginRegistry): void {
  registry.httpRoutes.push(
    {
      path: "/__iris__/patterns",
      handler: async (req, res) => {
        if (req.method === "GET") {
          await handlePatternsGet(req, res);
        } else if (req.method === "PUT") {
          await handlePatternsPut(req, res);
        } else if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
        } else {
          res.statusCode = 405;
          res.end();
        }
      },
      auth: "gateway",
      match: "exact",
      source: "iris-builtin",
    },
    {
      path: "/__iris__/patterns/test",
      handler: async (req, res) => {
        if (req.method === "POST") {
          await handlePatternsTest(req, res);
        } else {
          res.statusCode = 405;
          res.end();
        }
      },
      auth: "gateway",
      match: "exact",
      source: "iris-builtin",
    },
    {
      path: "/__iris__/patterns/ui",
      handler: async (req, res) => {
        await handlePatternsUi(req, res);
      },
      auth: "gateway",
      match: "exact",
      source: "iris-builtin",
    },
  );
}
