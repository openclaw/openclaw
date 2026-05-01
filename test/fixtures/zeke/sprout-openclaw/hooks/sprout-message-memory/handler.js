'use strict';

const crypto = require('node:crypto');

const DEFAULT_EVENTS_URL = 'http://host.docker.internal:3747/events/sprout-hook';
const SOURCE = 'sprout-openclaw';
const pendingBySession = new Map();

async function handler(event = {}) {
  try {
    if (isMessageReceived(event)) {
      rememberInbound(event);
      return;
    }
    if (!isMessageSent(event)) return;
    const pair = deriveMessagePair(event);
    if (!pair) return;
    await emitEvent(buildMessagePairEvent(pair), event);
  } catch (err) {
    await emitFailure(event, err);
  }
}

function rememberInbound(event) {
  const sessionId = sessionIdFromEvent(event);
  const content = contentFromEvent(event);
  if (!sessionId || !content) return;
  pendingBySession.set(sessionId, {
    session_id: sessionId,
    ross_content: content,
    ross_message_id: stableId('ross', sessionId, content, event.timestamp),
    timestamp: isoTimestamp(event.timestamp),
    model: modelFromEvent(event),
  });
}

function deriveMessagePair(event) {
  const sessionId = sessionIdFromEvent(event);
  if (!sessionId) return null;
  const pending = pendingBySession.get(sessionId);
  const sproutContent = contentFromEvent(event);
  if (!pending || !sproutContent) return null;
  pendingBySession.delete(sessionId);
  const timestamp = isoTimestamp(event.timestamp);
  const sproutMessageId = stableId('sprout', sessionId, sproutContent, timestamp);
  return {
    ...pending,
    sprout_content: sproutContent,
    sprout_message_id: sproutMessageId,
    timestamp,
    model: modelFromEvent(event) || pending.model || null,
    surface: 'openclaw',
    openclaw_turn_id: stableId('turn', sessionId, pending.ross_message_id, sproutMessageId),
  };
}

function buildMessagePairEvent(pair) {
  return {
    source: SOURCE,
    category: 'sprout',
    event_type: 'sprout:conversation.message_pair',
    severity: 'info',
    payload: pair,
  };
}

async function emitFailure(event, err) {
  const message = err && err.message ? err.message : String(err);
  try {
    await emitEvent({
      source: SOURCE,
      category: 'ops',
      event_type: 'ops:sprout.memory_emit_failed',
      severity: 'warning',
      payload: {
        agent_id: 'sprout',
        hook_name: 'on-message',
        classification: classifyError(err),
        target_event_type: 'sprout:conversation.message_pair',
        message: message.slice(0, 300),
        retryable: true,
        openclaw_turn_id: null,
        session_id: sessionIdFromEvent(event) || null,
      },
    }, event);
  } catch (_) {
    // Fail closed for the OpenClaw turn. The hook must not crash Gateway.
  }
}

async function emitEvent(envelope, event) {
  const fetchImpl = event.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch unavailable');
  }
  const token = tokenFromEnv(event.env || process.env);
  if (!token) {
    throw new Error('SPROUT_OPENCLAW_HOOK_TOKEN missing');
  }
  const res = await fetchImpl(event.eventsUrl || DEFAULT_EVENTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(envelope),
  });
  if (!res || res.status < 200 || res.status >= 300) {
    throw new Error(`event append failed with status ${res && res.status}`);
  }
}

function isMessageReceived(event) {
  return event.type === 'message:received' || (event.type === 'message' && event.action === 'received');
}

function isMessageSent(event) {
  return event.type === 'message:sent' || (event.type === 'message' && event.action === 'sent');
}

function sessionIdFromEvent(event) {
  return String(event.sessionKey || event.session_id || event.context?.sessionKey || 'hook:sprout');
}

function contentFromEvent(event) {
  const value =
    event.context?.content ||
    event.context?.bodyForAgent ||
    event.content ||
    event.message ||
    '';
  return typeof value === 'string' ? value.trim() : '';
}

function modelFromEvent(event) {
  const value = event.context?.model || event.model || null;
  return typeof value === 'string' && value ? value : null;
}

function isoTimestamp(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function stableId(...parts) {
  return crypto
    .createHash('sha256')
    .update(parts.map((part) => String(part == null ? '' : part)).join('\n'))
    .digest('hex')
    .slice(0, 24);
}

function tokenFromEnv(env) {
  return env.SPROUT_OPENCLAW_HOOK_TOKEN || '';
}

function classifyError(err) {
  const msg = err && err.message ? err.message.toLowerCase() : '';
  if (msg.includes('token') || msg.includes('auth')) return 'auth';
  if (msg.includes('status 4')) return 'schema';
  if (msg.includes('timeout')) return 'timeout';
  if (msg.includes('fetch') || msg.includes('network')) return 'network';
  return 'internal';
}

function resetPendingMessages() {
  pendingBySession.clear();
}

module.exports = handler;
module.exports.default = handler;
module.exports._test = {
  buildMessagePairEvent,
  deriveMessagePair,
  rememberInbound,
  resetPendingMessages,
  stableId,
};
