'use strict';

const DEFAULT_EVENTS_URL = 'http://host.docker.internal:3747/events/sprout-hook';

async function handler(event = {}) {
  const err = event.error || event.context?.error || {};
  const message = String(err.message || event.message || err || 'unknown hook error');
  const payload = {
    agent_id: 'sprout',
    hook_name: 'on-error',
    phase: 'on_error',
    classification: classify(message),
    message: message.slice(0, 300),
    stack_summary: String(err.stack || '').split('\n').slice(0, 5).filter(Boolean),
    tool_name: event.context?.tool_name || event.context?.toolName || null,
    openclaw_turn_id: event.context?.openclaw_turn_id || null,
    session_id: event.sessionKey || event.context?.session_id || null,
  };
  await emit(payload, event);
}

async function emit(payload, event) {
  const fetchImpl = event.fetch || globalThis.fetch;
  const token = event.env?.SPROUT_OPENCLAW_HOOK_TOKEN || process.env.SPROUT_OPENCLAW_HOOK_TOKEN || '';
  if (typeof fetchImpl !== 'function' || !token) return;
  try {
    await fetchImpl(event.eventsUrl || DEFAULT_EVENTS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'sprout-openclaw', category: 'ops', event_type: 'ops:sprout.hook_error', severity: 'warning', payload }),
    });
  } catch (err) {
    if (Array.isArray(event.telemetryErrors)) {
      event.telemetryErrors.push(String(err && err.message ? err.message : err));
    }
  }
}

function classify(message) {
  const msg = String(message).toLowerCase();
  if (msg.includes('token') || msg.includes('auth')) return 'auth';
  if (msg.includes('schema') || msg.includes('status 4')) return 'schema';
  if (msg.includes('timeout') || msg.includes('deadline')) return 'timeout';
  if (msg.includes('network') || msg.includes('fetch')) return 'network';
  return 'internal';
}

module.exports = handler;
module.exports.default = handler;
module.exports._test = { classify };
