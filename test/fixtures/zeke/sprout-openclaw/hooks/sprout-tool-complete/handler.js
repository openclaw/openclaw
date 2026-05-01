'use strict';

const preTool = require('../sprout-tool-attempt/handler');
const DEFAULT_EVENTS_URL = 'http://host.docker.internal:3747/events/sprout-hook';
const SOURCE = 'sprout-openclaw';

async function handler(event = {}) {
  const toolName = String(event.context?.tool_name || event.context?.toolName || event.tool_name || event.toolName || '').trim();
  if (!toolName) return;
  const payload = {
    agent_id: 'sprout',
    hook_name: 'post-tool',
    tool_name: toolName,
    normalized_tool_name: preTool._test.normalizeToolName(toolName),
    tool_source: preTool._test.toolSource(toolName),
    caller: { agent_id: 'sprout', surface: 'openclaw', session_id: String(event.sessionKey || event.context?.session_id || 'hook:sprout') },
    argument_shape: preTool._test.shapeSummary(event.context?.arguments || event.arguments || {}),
    duration_ms: Number(event.context?.duration_ms || event.duration_ms || 0),
    success: event.context?.success === false || event.success === false ? false : true,
    result_shape: preTool._test.shapeSummary(event.context?.result || event.result || {}),
    error_class: event.context?.error_class || event.error_class || null,
    openclaw_turn_id: event.openclaw_turn_id || event.context?.openclaw_turn_id || null,
  };
  await safeEmit(payload, event);
}

async function safeEmit(payload, event) {
  try {
    await emit(payload, event);
  } catch (err) {
    if (Array.isArray(event.telemetryErrors)) {
      event.telemetryErrors.push(String(err && err.message ? err.message : err));
    }
  }
}

async function emit(payload, event) {
  const fetchImpl = event.fetch || globalThis.fetch;
  const token = event.env?.SPROUT_OPENCLAW_HOOK_TOKEN || process.env.SPROUT_OPENCLAW_HOOK_TOKEN || '';
  if (typeof fetchImpl !== 'function' || !token) return;
  await fetchImpl(event.eventsUrl || DEFAULT_EVENTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: SOURCE, category: 'tool', event_type: 'tool:sprout.call_completed', severity: payload.success ? 'info' : 'warning', payload }),
  });
}

module.exports = handler;
module.exports.default = handler;
