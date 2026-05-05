const fs = require('fs');
const path = require('path');

let readinessShadow;
try {
  readinessShadow = require('../readiness-shadow.cjs');
} catch (_) {
  readinessShadow = {
    normalizeSubject(subject) {
      return String(subject || '')
        .replace(/^(re|fw|fwd):\s*/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    }
  };
}

const DEFAULT_OVERRIDES = {
  split_task_ids: [],
  merge_clusters: [],
  task_overrides: {},
  cluster_overrides: {}
};

function normalizeSpace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(value) {
  return normalizeSpace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleCase(value) {
  return normalizeSpace(value)
    .split(' ')
    .map(function(part) {
      return part ? part.charAt(0).toUpperCase() + part.slice(1) : '';
    })
    .join(' ');
}

function truncate(value, maxLen) {
  const text = String(value || '');
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1).trimEnd() + '…';
}

function stripPrefixes(subject) {
  return String(subject || '')
    .replace(/^(re|fw|fwd):\s*/gi, '')
    .trim();
}

function normalizeMailbox(raw) {
  const value = normalizeSpace(raw).toLowerCase();
  if (!value) return null;
  if (value === 'chris@') return 'chris@prestigiocustom.com';
  if (value === 'stitch@') return 'stitch@prestigiocustom.com';
  if (value === 'gmail@') return 'chris91744@gmail.com';
  return value;
}

function mailboxProvider(mailbox) {
  if (!mailbox) return 'unknown';
  if (mailbox.indexOf('gmail.com') !== -1) return 'gmail';
  if (mailbox.indexOf('prestigiocustom.com') !== -1) return 'microsoft';
  return 'unknown';
}

function parseMsgIdBlock(description) {
  const match = String(description || '').match(/\[msgId:\s*([^\]|]+)\s*\|\s*([^\]]+)\]/i);
  if (!match) {
    return { msgId: null, mailbox: null };
  }
  return {
    msgId: normalizeSpace(match[1]),
    mailbox: normalizeMailbox(match[2])
  };
}

function extractSubjectHint(description) {
  const text = String(description || '');
  const subjectMatch = text.match(/(?:^|\n)Subject:\s*(.+)$/im);
  if (subjectMatch) {
    return cleanSubjectCandidate(subjectMatch[1]);
  }

  const lines = text
    .split(/\n+/)
    .map(function(line) { return line.trim(); })
    .filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    if (/^(re|fw|fwd):/i.test(lines[i])) {
      return cleanSubjectCandidate(lines[i]);
    }
  }

  if (lines[0] && (
    lines[0].indexOf('//') !== -1
    || lines[0].indexOf(' / ') !== -1
    || /^quote\b/i.test(lines[0])
    || /^estimate\b/i.test(lines[0])
  )) {
    return cleanSubjectCandidate(lines[0]);
  }

  return null;
}

function cleanSubjectCandidate(value) {
  let subject = normalizeSpace(value);
  subject = subject.replace(/\[msgId:[^\]]+\]/i, '').trim();

  const summaryTailPatterns = [
    /^(Delegate to|Diana should|Jay should|Chris should)\b/i,
    /^[A-Z][^.]{0,140}\b(emailed|asked|asks|says|said|requested|confirmed|noted|mentioned|shared|wrote|replied|sent|submitted|wants|wanted|needs|need|could|can|will be|would like)\b/i
  ];

  const sentenceBreaks = Array.from(subject.matchAll(/\.\s+/g));
  for (let i = 0; i < sentenceBreaks.length; i += 1) {
    const marker = sentenceBreaks[i];
    const breakIndex = marker.index;
    if (typeof breakIndex !== 'number') continue;
    const before = subject.slice(0, breakIndex).trim();
    const after = subject.slice(breakIndex + marker[0].length).trim();
    if (!before || !after) continue;
    if (summaryTailPatterns.some(function(pattern) { return pattern.test(after); })) {
      subject = before;
      break;
    }
  }

  return subject || null;
}

function extractFirstDate(text) {
  const match = String(text || '').match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i);
  return match ? titleCase(match[0]) : null;
}

function firstNonEmptyParagraph(text) {
  const parts = String(text || '')
    .split(/\n\s*\n/)
    .map(function(part) { return normalizeSpace(part); })
    .filter(Boolean);
  return parts[0] || '';
}

function extractIdentifiers(text) {
  const combined = String(text || '');
  const identifiers = [];
  const patterns = [
    { type: 'claim', re: /\bclaim\s*#?\s*([A-Za-z0-9-]+)/gi },
    { type: 'po', re: /\bpo\s*#?\s*([A-Za-z0-9-]+)/gi },
    { type: 'quote', re: /\bquote\s*#?\s*([A-Za-z0-9-]*\d[A-Za-z0-9-]*)/gi },
    { type: 'estimate', re: /\bestimate\s*#?\s*([A-Za-z0-9-]*\d[A-Za-z0-9-]*)/gi }
  ];

  patterns.forEach(function(pattern) {
    let match;
    while ((match = pattern.re.exec(combined)) !== null) {
      identifiers.push({
        type: pattern.type,
        value: normalizeSpace(match[1]),
        key: pattern.type + ':' + normalizeSpace(match[1]).toLowerCase()
      });
    }
  });

  return identifiers;
}

function parseQuoteTitle(content) {
  const match = String(content || '').match(/^QUOTE:\s*(.+?)\s+[—-]\s+(.+)$/i);
  if (!match) return null;

  const client = normalizeSpace(match[1]);
  const remainder = normalizeSpace(match[2]);
  let property = null;

  const parenMatch = remainder.match(/\(([^)]+)\)\s*$/);
  if (parenMatch) {
    property = normalizeSpace(parenMatch[1]);
  } else {
    const start = remainder.split(/\s+/)[0];
    if (start && /^[A-Z][A-Za-z0-9'.-]+$/.test(start)) {
      property = normalizeSpace(start);
    }
  }

  return {
    client,
    property,
    remainder
  };
}

function traceNotes(provider, subjectHint) {
  if (!subjectHint) {
    return 'No subject hint was preserved, so this task should be treated as a singleton unless another explicit identifier matches.';
  }
  if (provider === 'microsoft') {
    return 'Use the Mailroom task packet for default briefings. Use fetch-thread-by-subject only for explicit verification or to get a current message id for threaded reply drafts; msgId is secondary because Microsoft message IDs go stale after moves/archive.';
  }
  if (provider === 'gmail') {
    return 'Use the Mailroom task packet for default briefings. Use Gmail subject search/detail only for explicit verification; Gmail has no full threaded reply action, so msgId stays secondary only.';
  }
  return 'Use the Mailroom task packet for default briefings. Use subject-based retrieval only for explicit verification or draft anchoring; msgId is preserved only as a secondary hint.';
}

function buildTrace(description, content) {
  const parsedMsg = parseMsgIdBlock(description);
  const subjectHint = extractSubjectHint(description);
  const provider = mailboxProvider(parsedMsg.mailbox);
  const normalizedSubject = subjectHint
    ? readinessShadow.normalizeSubject(stripPrefixes(subjectHint))
    : null;
  let sourceType = 'manual';
  if (subjectHint || parsedMsg.msgId) {
    sourceType = 'email';
  } else if (/related to .+@/i.test(description)) {
    sourceType = 'email';
  }

  let traceabilityConfidence = 0.25;
  if (subjectHint && parsedMsg.mailbox && provider === 'microsoft') {
    traceabilityConfidence = 0.95;
  } else if (subjectHint && parsedMsg.mailbox && provider === 'gmail') {
    traceabilityConfidence = 0.82;
  } else if (subjectHint) {
    traceabilityConfidence = 0.7;
  } else if (parsedMsg.msgId) {
    traceabilityConfidence = 0.5;
  }

  let threadLookupMethod = 'none';
  if (subjectHint && provider === 'microsoft') {
    threadLookupMethod = 'subject';
  } else if (subjectHint && provider === 'gmail') {
    threadLookupMethod = 'subject_search_best_effort';
  } else if (parsedMsg.msgId) {
    threadLookupMethod = 'message_id_hint_only';
  }

  return {
    source_type: sourceType,
    mailbox: parsedMsg.mailbox,
    provider,
    subject_hint: subjectHint,
    normalized_subject_lookup_key: normalizedSubject,
    thread_lookup_method: threadLookupMethod,
    msg_id: parsedMsg.msgId,
    msg_id_is_secondary_only: Boolean(parsedMsg.msgId),
    traceability_confidence: Number(traceabilityConfidence.toFixed(2)),
    notes: traceNotes(provider, subjectHint),
    description_paragraph: firstNonEmptyParagraph(description),
    identifiers: extractIdentifiers(description + '\n' + content)
  };
}

function inferDelegate(content, lane) {
  const text = String(content || '').trim().toLowerCase();
  if (text.indexOf('ask diana') === 0 || text.indexOf('diana:') === 0 || lane === 'Waiting For Diana') {
    return 'Diana';
  }
  if (text.indexOf('ask jay') === 0 || text.indexOf('jay:') === 0) {
    return 'Jay';
  }
  return null;
}

function inferIntent(task, trace) {
  const content = String(task.content || '').toLowerCase();
  const description = String(task.description || '').toLowerCase();
  if (content.indexOf('quote:') === 0) return 'quote';
  if (content.indexOf('follow up') === 0) return 'follow_up';
  if (content.indexOf('reply to') === 0) return 'reply';
  if (content.indexOf('ask diana') === 0 || content.indexOf('ask jay') === 0 || task.project_name === 'Waiting For' || task.project_name === 'Waiting For Diana') {
    return 'delegation';
  }
  if (content.indexOf('pay ') === 0 || description.indexOf('bill') !== -1) return 'finance';
  if (content.indexOf('review ') === 0 && (description.indexOf('security') !== -1 || description.indexOf('password') !== -1)) {
    return 'security';
  }
  if (content.indexOf('annual physical') !== -1 || content.indexOf('marek') !== -1) return 'appointment';
  if (content.indexOf('rav4') !== -1 || content.indexOf('vacuum filter') !== -1) return 'maintenance';
  if (content.indexOf('look up ') === 0) return 'research';
  return trace.source_type === 'email' ? 'email_follow_up' : 'task';
}

function extractAssetKey(task, trace) {
  const text = (String(task.content || '') + '\n' + String(task.description || '')).toLowerCase();
  if (text.indexOf('rav4') !== -1) {
    return {
      key: 'asset:rav4',
      display: 'RAV4 Maintenance',
      reason: 'same asset keyword (RAV4)'
    };
  }
  if (text.indexOf('marek') !== -1 && (text.indexOf('physical') !== -1 || text.indexOf('appointment') !== -1 || text.indexOf('form') !== -1)) {
    return {
      key: 'asset:marek-physical',
      display: 'Marek Physical — Apr 27',
      reason: 'same appointment/form packet'
    };
  }
  if (text.indexOf('death valley') !== -1) {
    return {
      key: 'asset:death-valley',
      display: 'Death Valley Planning',
      reason: 'same trip-planning keyword'
    };
  }
  if (trace.identifiers.some(function(entry) { return entry.key.indexOf('claim:') === 0; })) {
    const claim = trace.identifiers.find(function(entry) { return entry.key.indexOf('claim:') === 0; });
    return {
      key: claim.key,
      display: 'Claim ' + claim.value,
      reason: 'same claim identifier'
    };
  }
  return null;
}

function buildQuotePacket(task, trace) {
  const parsed = parseQuoteTitle(task.content);
  if (!parsed || !parsed.client) return null;
  if (!parsed.property) return null;
  return {
    key: 'quote-packet:' + slugify(parsed.client) + ':' + slugify(parsed.property),
    client: parsed.client,
    property: parsed.property,
    display_name: parsed.client + ' — Quotes',
    summary: parsed.property + ' quote packet that should be worked together.',
    aliases: [parsed.client, parsed.property],
    reason: 'same client/property quote packet'
  };
}

function inferLane(projectName) {
  if (projectName === 'Waiting For Diana') return 'Waiting For Diana';
  if (projectName === 'Waiting For') return 'Waiting For';
  if (projectName === 'Next Actions') return 'Next Actions';
  if (projectName === 'Someday / Maybe') return 'Someday / Maybe';
  if (projectName === 'Personal ☯️') return 'Personal';
  return projectName || 'Unknown';
}

function prepareTask(task, overrides) {
  const trace = buildTrace(task.description, task.content);
  const lane = inferLane(task.project_name);
  const delegate = inferDelegate(task.content, lane);
  const quotePacket = buildQuotePacket(task, trace);
  const assetKey = extractAssetKey(task, trace);
  const taskOverride = (overrides.task_overrides && overrides.task_overrides[task.id]) || {};
  return {
    task_id: task.id,
    content: task.content || '',
    description: task.description || '',
    project_name: task.project_name || 'Unknown',
    section_name: task.section_name || null,
    labels: Array.isArray(task.labels) ? task.labels.slice() : [],
    priority: task.priority || 1,
    due_date: task.due ? task.due.date : null,
    due_string: task.due ? task.due.string : null,
    due_recurring: Boolean(task.due && task.due.recurring),
    created_at: task.created_at || null,
    updated_at: task.updated_at || null,
    lane,
    delegate,
    intent: inferIntent(task, trace),
    trace,
    quote_packet: quotePacket,
    asset_key: assetKey,
    identifiers: trace.identifiers.slice(),
    task_override: taskOverride
  };
}

function clusterCandidateMaps(preparedTasks) {
  const maps = {
    subject: new Map(),
    quotePacket: new Map(),
    identifier: new Map(),
    asset: new Map()
  };

  preparedTasks.forEach(function(task) {
    if (task.trace.normalized_subject_lookup_key) {
      const key = 'subject:' + task.trace.normalized_subject_lookup_key;
      pushToMap(maps.subject, key, task.task_id);
    }
    if (task.quote_packet) {
      pushToMap(maps.quotePacket, task.quote_packet.key, task.task_id);
    }
    task.identifiers.forEach(function(identifier) {
      pushToMap(maps.identifier, identifier.key, task.task_id);
    });
    if (task.asset_key) {
      pushToMap(maps.asset, task.asset_key.key, task.task_id);
    }
  });

  return maps;
}

function pushToMap(map, key, value) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(value);
}

function chooseClusterSeed(task, maps, overrides) {
  const splitSet = new Set((overrides.split_task_ids || []).map(String));
  if (splitSet.has(String(task.task_id))) {
    return {
      seed: 'singleton:' + task.task_id,
      reason: 'manual split override keeps this task separate',
      mode: 'singleton'
    };
  }

  if (task.task_override && task.task_override.force_cluster_id) {
    return {
      seed: String(task.task_override.force_cluster_id),
      reason: task.task_override.why_in_cluster || 'manual override assigned this task to a cluster',
      mode: 'override'
    };
  }

  const subjectKey = task.trace.normalized_subject_lookup_key
    ? 'subject:' + task.trace.normalized_subject_lookup_key
    : null;
  if (subjectKey && (maps.subject.get(subjectKey) || []).length > 1) {
    return {
      seed: subjectKey,
      reason: 'same normalized subject root',
      mode: 'subject'
    };
  }

  if (task.quote_packet && (maps.quotePacket.get(task.quote_packet.key) || []).length > 1) {
    return {
      seed: task.quote_packet.key,
      reason: task.quote_packet.reason,
      mode: 'quotePacket'
    };
  }

  for (let i = 0; i < task.identifiers.length; i += 1) {
    const identifier = task.identifiers[i];
    if ((maps.identifier.get(identifier.key) || []).length > 1) {
      return {
        seed: identifier.key,
        reason: 'same explicit identifier (' + identifier.type.toUpperCase() + ' ' + identifier.value + ')',
        mode: 'identifier'
      };
    }
  }

  if (task.asset_key && (maps.asset.get(task.asset_key.key) || []).length > 1) {
    return {
      seed: task.asset_key.key,
      reason: task.asset_key.reason,
      mode: 'asset'
    };
  }

  return {
    seed: 'singleton:' + task.task_id,
    reason: 'no safe multi-task match; left as a singleton to avoid over-merging',
    mode: 'singleton'
  };
}

function groupTasks(preparedTasks, overrides) {
  const maps = clusterCandidateMaps(preparedTasks);
  const groups = new Map();
  preparedTasks.forEach(function(task) {
    const selected = chooseClusterSeed(task, maps, overrides);
    if (!groups.has(selected.seed)) {
      groups.set(selected.seed, {
        seed: selected.seed,
        mode: selected.mode,
        tasks: [],
        reasons: []
      });
    }
    const group = groups.get(selected.seed);
    group.tasks.push(task);
    group.reasons.push({
      task_id: task.task_id,
      text: selected.reason
    });
  });

  applyMergeOverrides(groups, overrides);
  return groups;
}

function applyMergeOverrides(groups, overrides) {
  (overrides.merge_clusters || []).forEach(function(entry) {
    const from = entry && entry.cluster_id ? String(entry.cluster_id) : null;
    const into = entry && entry.into ? String(entry.into) : null;
    if (!from || !into || from === into) return;
    if (!groups.has(from)) return;
    if (!groups.has(into)) {
      groups.set(into, {
        seed: into,
        mode: 'override',
        tasks: [],
        reasons: []
      });
    }
    const target = groups.get(into);
    const source = groups.get(from);
    target.tasks = target.tasks.concat(source.tasks);
    target.reasons = target.reasons.concat(source.reasons);
    groups.delete(from);
  });
}

function reasonList(mode, firstTask, commonReason) {
  if (mode === 'quotePacket' && firstTask.quote_packet) {
    return [
      'same client',
      'same property/project family',
      'same quote intent'
    ];
  }
  if (mode === 'subject') {
    return [
      'same normalized subject root',
      'same source-thread family'
    ];
  }
  if (mode === 'identifier') {
    return [commonReason];
  }
  if (mode === 'asset') {
    return [commonReason];
  }
  return [commonReason];
}

function clusterKind(mode, task) {
  if (mode === 'quotePacket') return 'client_quote_batch';
  if (mode === 'subject' && task.intent === 'delegation') return 'delegated_packet';
  if (task.intent === 'delegation') return 'delegated_wait';
  if (task.intent === 'finance') return 'admin_finance';
  if (task.intent === 'security') return 'security_review';
  if (task.intent === 'appointment') return 'appointment_packet';
  if (task.intent === 'maintenance') return 'maintenance_packet';
  if (task.intent === 'research') return 'research_packet';
  return 'task_packet';
}

function blockingParty(tasks) {
  const delegates = Array.from(new Set(tasks.map(function(task) { return task.delegate; }).filter(Boolean)));
  if (delegates.length === 1) return delegates[0];
  if (tasks.every(function(task) { return task.lane === 'Waiting For Diana'; })) return 'Diana';
  if (tasks.some(function(task) { return task.lane === 'Waiting For' || task.lane === 'Waiting For Diana'; })) return 'External';
  return 'Chris';
}

function clusterAliases(tasks, cluster) {
  const aliases = new Set();
  aliases.add(cluster.display_name);
  tasks.forEach(function(task) {
    if (task.quote_packet) {
      aliases.add(task.quote_packet.client);
      aliases.add(task.quote_packet.property);
    }
    if (task.trace.subject_hint) {
      aliases.add(stripPrefixes(task.trace.subject_hint));
    }
    task.identifiers.forEach(function(identifier) {
      aliases.add(identifier.value);
    });
    if (task.delegate) aliases.add(task.delegate);
  });

  return Array.from(aliases)
    .map(normalizeSpace)
    .filter(Boolean)
    .filter(function(value, index, array) { return array.indexOf(value) === index; })
    .slice(0, 8);
}

function clusterDisplayName(group, tasks) {
  const first = tasks[0];
  if (group.mode === 'quotePacket' && first.quote_packet) {
    return first.quote_packet.display_name;
  }
  if (group.mode === 'subject' && first.trace.subject_hint) {
    const clean = stripPrefixes(first.trace.subject_hint);
    if (/^quote for /i.test(clean)) {
      return clean.replace(/^quote for /i, '') + ' — Quote Thread';
    }
    return truncate(clean, 70);
  }
  if (group.mode === 'asset' && first.asset_key) {
    return first.asset_key.display;
  }
  if (group.mode === 'identifier' && first.identifiers.length > 0) {
    const identifier = first.identifiers[0];
    return identifier.type.toUpperCase() + ' ' + identifier.value;
  }
  return truncate(first.content, 70);
}

function clusterId(group, tasks) {
  const first = tasks[0];
  if (group.mode === 'quotePacket' && first.quote_packet) {
    return 'client-' + slugify(first.quote_packet.client) + '-quotes';
  }
  if (group.mode === 'asset' && first.asset_key) {
    return slugify(first.asset_key.display);
  }
  if (group.mode === 'identifier' && first.identifiers.length > 0) {
    return slugify(first.identifiers[0].type + ' ' + first.identifiers[0].value);
  }
  if (group.mode === 'subject' && first.trace.subject_hint) {
    return slugify(stripPrefixes(first.trace.subject_hint).slice(0, 80));
  }
  return 'task-' + slugify(first.content).slice(0, 48) + '-' + slugify(first.task_id).slice(0, 8);
}

function sortTasks(tasks) {
  return tasks.slice().sort(function(left, right) {
    const leftDue = left.due_date || '9999-12-31';
    const rightDue = right.due_date || '9999-12-31';
    if (leftDue !== rightDue) return leftDue.localeCompare(rightDue);
    if ((right.priority || 0) !== (left.priority || 0)) return (right.priority || 0) - (left.priority || 0);
    return left.content.localeCompare(right.content);
  });
}

function summaryLine(detail) {
  return detail.display_name + ' — ' + detail.task_count + ' task(s). ' + detail.summary;
}

function workPacket(kind, blockingPartyValue) {
  if (kind === 'client_quote_batch') {
    return 'Stay in this cluster until the quote packet is reviewed together and the missing inputs are clear.';
  }
  if (kind === 'delegated_wait' || kind === 'delegated_packet') {
    return 'Stay in this cluster until the owner, the last source thread, and the next follow-up are all clear.';
  }
  if (kind === 'appointment_packet') {
    return 'Stay in this cluster until the appointment and its prep item are handled together.';
  }
  if (kind === 'maintenance_packet') {
    return 'Stay in this cluster until the related maintenance items are checked together.';
  }
  if (blockingPartyValue === 'Chris') {
    return 'Stay in this cluster until the packet is understood end to end before you switch away.';
  }
  return 'Stay in this cluster until the waiting state and the next follow-up are both explicit.';
}

function recommendedSequence(detail) {
  if (detail.kind === 'client_quote_batch') {
    return [
      'review the preserved tasks and source traces',
      'identify missing quote inputs across the packet',
      'work the quote packet together before switching contexts'
    ];
  }
  if (detail.kind === 'delegated_wait' || detail.kind === 'delegated_packet') {
    return [
      'review the preserved tasks and source traces',
      'confirm who owns the next move',
      'decide the single best follow-up before leaving the cluster'
    ];
  }
  return [
    'review the preserved tasks and source traces',
    'confirm why the tasks belong together',
    'decide the next concrete move for the packet'
  ];
}

function clusterSummary(detail, firstTask) {
  if (detail.kind === 'client_quote_batch' && firstTask.quote_packet) {
    return firstTask.quote_packet.summary;
  }
  if (detail.kind === 'delegated_wait' || detail.kind === 'delegated_packet') {
    return 'Tasks that are all waiting on the same work packet to move forward.';
  }
  if (detail.kind === 'appointment_packet') {
    return 'Appointment and prep tasks that should be handled together.';
  }
  if (detail.kind === 'maintenance_packet') {
    return 'Related maintenance tasks for the same asset or routine.';
  }
  return 'A conservative work packet built without hiding the original tasks.';
}

function priorityScore(tasks, kind) {
  const today = new Date().toISOString().slice(0, 10);
  let score = 0.2;
  if (kind === 'client_quote_batch') score += 0.18;
  if (tasks.some(function(task) { return task.lane === 'Next Actions'; })) score += 0.14;
  if (tasks.some(function(task) { return task.lane === 'Waiting For' || task.lane === 'Waiting For Diana'; })) score += 0.1;
  score += Math.min(0.2, Math.max(0, tasks.length - 1) * 0.05);

  tasks.forEach(function(task) {
    if (task.priority >= 4) score += 0.08;
    else if (task.priority >= 3) score += 0.05;
    if (task.due_date) {
      if (task.due_date < today) score += 0.18;
      else if (task.due_date === today) score += 0.14;
      else score += 0.04;
    }
  });

  return Number(Math.min(0.99, score).toFixed(2));
}

function clusterConfidence(group) {
  if (group.mode === 'subject') return 0.96;
  if (group.mode === 'identifier') return 0.92;
  if (group.mode === 'quotePacket') return 0.88;
  if (group.mode === 'asset') return 0.82;
  return 0.62;
}

function taskWhyInCluster(detail, task, groupReason) {
  if (detail.kind === 'client_quote_batch' && task.quote_packet) {
    return 'Same quote packet: ' + task.quote_packet.client + ' + ' + task.quote_packet.property + '.';
  }
  if (groupReason) {
    return titleCase(groupReason) + '.';
  }
  return 'Left separate on purpose to avoid over-merging.';
}

function detailFileName(clusterId) {
  return slugify(clusterId) + '.json';
}

function applyClusterOverrides(detail, overrides) {
  const override = (overrides.cluster_overrides && overrides.cluster_overrides[detail.cluster_id]) || null;
  if (!override) return detail;
  return Object.assign({}, detail, {
    display_name: override.display_name || detail.display_name,
    aliases: Array.isArray(override.aliases) ? override.aliases.slice() : detail.aliases,
    kind: override.kind || detail.kind,
    summary: override.summary || detail.summary,
    work_packet: override.work_packet || detail.work_packet,
    blocking_party: override.blocking_party || detail.blocking_party,
    priority_score: typeof override.priority_score === 'number' ? override.priority_score : detail.priority_score,
    pinned_order: typeof override.pinned_order === 'number' ? override.pinned_order : detail.pinned_order
  });
}

function defaultOverrides() {
  return JSON.parse(JSON.stringify(DEFAULT_OVERRIDES));
}

function normalizeOverrides(input) {
  return Object.assign(defaultOverrides(), input || {});
}

function buildOverlay(tasksPayload, options) {
  const overrides = normalizeOverrides((options && options.overrides) || {});
  const generatedAt = (options && options.generatedAt) || new Date().toISOString();
  const preparedTasks = sortTasks((tasksPayload.allTasks || []).map(function(task) {
    return prepareTask(task, overrides);
  }));
  const grouped = groupTasks(preparedTasks, overrides);
  const details = [];
  const taskIndex = {};

  grouped.forEach(function(group) {
    const tasks = sortTasks(group.tasks);
    const first = tasks[0];
    const clusterId = clusterIdForGroup(group, tasks);
    const commonReason = group.reasons[0] ? group.reasons[0].text : 'conservative grouping';
    let detail = {
      cluster_id: clusterId,
      display_name: clusterDisplayName(group, tasks),
      aliases: [],
      generated_at: generatedAt,
      source_tasks_synced_at: tasksPayload.syncedAt || null,
      source_tasks_fetched_at: tasksPayload.syncedAt || null,
      lane: mostCommon(tasks.map(function(task) { return task.lane; })) || 'Unknown',
      kind: clusterKind(group.mode, first),
      summary: '',
      work_packet: '',
      blocking_party: blockingParty(tasks),
      priority_score: priorityScore(tasks, clusterKind(group.mode, first)),
      confidence: clusterConfidence(group),
      group_reasons: reasonList(group.mode, first, commonReason),
      recommended_sequence: [],
      task_count: tasks.length,
      detail_file: path.join('by-id', detailFileName(clusterId)),
      pinned_order: null,
      stale_after_seconds: 600,
      tasks: []
    };

    detail.summary = clusterSummary(detail, first);
    detail.work_packet = workPacket(detail.kind, detail.blocking_party);
    detail.recommended_sequence = recommendedSequence(detail);
    detail.aliases = clusterAliases(tasks, detail);
    detail = applyClusterOverrides(detail, overrides);

    detail.tasks = tasks.map(function(task) {
      const groupReason = group.reasons.find(function(entry) { return entry.task_id === task.task_id; });
      const taskDetail = {
        task_id: task.task_id,
        content: task.content,
        description: task.description,
        project_name: task.project_name,
        section_name: task.section_name,
        labels: task.labels,
        priority: task.priority,
        due_date: task.due_date,
        due_string: task.due_string,
        created_at: task.created_at,
        updated_at: task.updated_at,
        why_in_cluster: taskWhyInCluster(detail, task, groupReason && groupReason.text),
        trace: {
          source_type: task.trace.source_type,
          mailbox: task.trace.mailbox,
          provider: task.trace.provider,
          subject_hint: task.trace.subject_hint,
          normalized_subject_lookup_key: task.trace.normalized_subject_lookup_key,
          thread_lookup_method: task.trace.thread_lookup_method,
          msg_id: task.trace.msg_id,
          msg_id_is_secondary_only: task.trace.msg_id_is_secondary_only,
          traceability_confidence: task.trace.traceability_confidence,
          notes: task.trace.notes
        },
        traceability_confidence: task.trace.traceability_confidence
      };

      taskIndex[task.task_id] = {
        cluster_id: detail.cluster_id,
        display_name: detail.display_name,
        detail_file: detail.detail_file,
        lane: detail.lane,
        kind: detail.kind,
        subject_hint: task.trace.subject_hint,
        normalized_subject_lookup_key: task.trace.normalized_subject_lookup_key,
        mailbox: task.trace.mailbox,
        provider: task.trace.provider,
        thread_lookup_method: task.trace.thread_lookup_method,
        msg_id: task.trace.msg_id,
        msg_id_is_secondary_only: task.trace.msg_id_is_secondary_only,
        traceability_confidence: task.trace.traceability_confidence,
        why_in_cluster: taskDetail.why_in_cluster
      };

      return taskDetail;
    });

    details.push(detail);
  });

  details.sort(function(left, right) {
    const pinLeft = typeof left.pinned_order === 'number' ? left.pinned_order : Number.MAX_SAFE_INTEGER;
    const pinRight = typeof right.pinned_order === 'number' ? right.pinned_order : Number.MAX_SAFE_INTEGER;
    if (pinLeft !== pinRight) return pinLeft - pinRight;
    if (right.priority_score !== left.priority_score) return right.priority_score - left.priority_score;
    if (right.task_count !== left.task_count) return right.task_count - left.task_count;
    return left.display_name.localeCompare(right.display_name);
  });

  const summary = {
    generated_at: generatedAt,
    source_tasks_synced_at: tasksPayload.syncedAt || null,
    task_count: preparedTasks.length,
    cluster_count: details.length,
    stale_after_seconds: 600,
    clusters: details.map(function(detail) {
      return {
        cluster_id: detail.cluster_id,
        display_name: detail.display_name,
        aliases: detail.aliases,
        lane: detail.lane,
        kind: detail.kind,
        summary: detail.summary,
        blocking_party: detail.blocking_party,
        priority_score: detail.priority_score,
        task_count: detail.task_count,
        confidence: detail.confidence,
        detail_file: detail.detail_file
      };
    })
  };

  const debugSummary = [
    '# Todoist Cluster Overlay',
    '',
    'Generated at: ' + generatedAt,
    'Source tasks synced at: ' + (tasksPayload.syncedAt || 'unknown'),
    'Task count: ' + preparedTasks.length,
    'Cluster count: ' + details.length,
    '',
    '## Clusters'
  ].concat(details.map(function(detail) {
    return '- ' + summaryLine(detail);
  })).join('\n') + '\n';

  return {
    summary: summary,
    task_index: taskIndex,
    details: details,
    debug_summary: debugSummary,
    overrides_used: overrides
  };
}

function flattenAllTasks(tasksPayload) {
  if (Array.isArray(tasksPayload.allTasks)) {
    return tasksPayload.allTasks.slice();
  }

  const byProject = tasksPayload && tasksPayload.byProject && typeof tasksPayload.byProject === 'object'
    ? tasksPayload.byProject
    : {};

  return Object.keys(byProject).reduce(function(all, projectName) {
    const tasks = Array.isArray(byProject[projectName]) ? byProject[projectName] : [];
    tasks.forEach(function(task) {
      all.push(Object.assign({ project_name: projectName }, task));
    });
    return all;
  }, []);
}

function buildExecutionCandidateMaps(preparedTasks) {
  const maps = {
    subject: new Map(),
    quotePacket: new Map(),
    identifier: new Map()
  };

  preparedTasks.forEach(function(task) {
    if (task.trace.normalized_subject_lookup_key) {
      pushToMap(maps.subject, 'subject:' + task.trace.normalized_subject_lookup_key, task.task_id);
    }
    if (task.quote_packet) {
      pushToMap(maps.quotePacket, task.quote_packet.key, task.task_id);
    }
    task.identifiers.forEach(function(identifier) {
      pushToMap(maps.identifier, identifier.key, task.task_id);
    });
  });

  return maps;
}

function chooseExecutionSeed(task, maps) {
  const subjectKey = task.trace.normalized_subject_lookup_key
    ? 'subject:' + task.trace.normalized_subject_lookup_key
    : null;
  if (subjectKey && (maps.subject.get(subjectKey) || []).length > 1) {
    return {
      seed: subjectKey,
      reason: 'same exact normalized subject',
      mode: 'subject'
    };
  }

  if (task.quote_packet && (maps.quotePacket.get(task.quote_packet.key) || []).length > 1) {
    return {
      seed: task.quote_packet.key,
      reason: 'same explicit quote packet',
      mode: 'quotePacket'
    };
  }

  for (let i = 0; i < task.identifiers.length; i += 1) {
    const identifier = task.identifiers[i];
    if ((maps.identifier.get(identifier.key) || []).length > 1) {
      return {
        seed: identifier.key,
        reason: 'same exact structured identifier (' + identifier.type.toUpperCase() + ' ' + identifier.value + ')',
        mode: 'identifier'
      };
    }
  }

  return {
    seed: 'singleton:' + task.task_id,
    reason: 'no exact-safe execution match; kept as a singleton',
    mode: 'singleton'
  };
}

function groupExecutionTasks(preparedTasks) {
  const maps = buildExecutionCandidateMaps(preparedTasks);
  const groups = new Map();

  preparedTasks.forEach(function(task) {
    const selected = chooseExecutionSeed(task, maps);
    if (!groups.has(selected.seed)) {
      groups.set(selected.seed, {
        seed: selected.seed,
        mode: selected.mode,
        tasks: [],
        reasons: []
      });
    }
    const group = groups.get(selected.seed);
    group.tasks.push(task);
    group.reasons.push({
      task_id: task.task_id,
      text: selected.reason
    });
  });

  return groups;
}

function executionClusterKind(group, firstTask) {
  if (group.mode === 'subject') return 'thread_cluster';
  if (group.mode === 'quotePacket') return 'quote_packet';
  if (group.mode === 'identifier') return 'identifier_packet';
  if (firstTask.intent === 'quote') return 'quote_singleton';
  return 'task_singleton';
}

function executionClusterDisplayName(group, tasks) {
  const first = tasks[0];
  if (group.mode === 'quotePacket' && first.quote_packet) {
    return first.quote_packet.client + ' — ' + first.quote_packet.property;
  }
  if (group.mode === 'subject' && first.trace.subject_hint) {
    return truncate(stripPrefixes(first.trace.subject_hint), 70);
  }
  if (group.mode === 'identifier' && first.identifiers.length > 0) {
    const identifier = first.identifiers[0];
    return identifier.type.toUpperCase() + ' ' + identifier.value;
  }
  return truncate(first.content, 70);
}

function executionClusterSummary(detail, firstTask) {
  if (detail.kind === 'thread_cluster') {
    return 'Tasks that point at the same exact email thread.';
  }
  if (detail.kind === 'quote_packet' && firstTask.quote_packet) {
    return 'Tasks that belong to the same exact quote packet for ' + firstTask.quote_packet.client + '.';
  }
  if (detail.kind === 'identifier_packet') {
    return 'Tasks grouped only because they share the same exact structured identifier.';
  }
  if (detail.kind === 'quote_singleton') {
    return 'A single quote task kept separate on purpose.';
  }
  return 'A single next action kept separate on purpose.';
}

function executionPriorityScore(tasks, kind) {
  const today = new Date().toISOString().slice(0, 10);
  let score = 0.12;

  tasks.forEach(function(task) {
    const content = String(task.content || '').toLowerCase();
    if (content.indexOf('quote:') === 0) score += 0.16;
    if (content.indexOf('reply ') === 0 || content.indexOf('respond ') === 0) score += 0.12;
    if (content.indexOf('follow up') === 0 || content.indexOf('confirm ') === 0) score += 0.1;

    if (task.due_date) {
      if (task.due_date < today) score += 0.22;
      else if (task.due_date === today) score += 0.18;
      else score += 0.08;
    } else {
      score += 0.03;
    }

    if (task.priority >= 4) score += 0.08;
    else if (task.priority >= 3) score += 0.05;
    else if (task.priority >= 2) score += 0.03;
  });

  if (kind === 'quote_packet' || kind === 'quote_singleton') {
    score += 0.08;
  }
  if (tasks.length > 1) {
    score += Math.min(0.12, (tasks.length - 1) * 0.04);
  }

  return Number(Math.min(0.99, score).toFixed(2));
}

function executionClusterConfidence(group) {
  if (group.mode === 'subject') return 0.98;
  if (group.mode === 'identifier') return 0.95;
  if (group.mode === 'quotePacket') return 0.9;
  return 0.76;
}

function executionGroupReasons(group, commonReason) {
  if (group.mode === 'subject') {
    return ['same exact normalized subject root', 'same source-thread family'];
  }
  if (group.mode === 'quotePacket') {
    return ['same explicit quote packet'];
  }
  if (group.mode === 'identifier') {
    return [commonReason];
  }
  return [commonReason];
}

function executionTaskWhyInCluster(group, task, groupReason) {
  if (group.mode === 'subject' && task.trace.subject_hint) {
    return 'Same exact subject root: ' + stripPrefixes(task.trace.subject_hint) + '.';
  }
  if (group.mode === 'quotePacket' && task.quote_packet) {
    return 'Same explicit quote packet for ' + task.quote_packet.client + ' / ' + task.quote_packet.property + '.';
  }
  if (groupReason) {
    return titleCase(groupReason) + '.';
  }
  return 'Kept separate to avoid over-clustering.';
}

function executionMailboxHint(task) {
  const mailbox = normalizeSpace(task.trace.mailbox || '').toLowerCase();
  if (!mailbox) return null;
  if (mailbox === 'stitch@prestigiocustom.com') return 'stitch';
  if (mailbox === 'chris@prestigiocustom.com') return 'chris';
  if (mailbox === 'chris91744@gmail.com') return 'gmail';
  return mailbox;
}

function buildExecutionOverlay(tasksPayload, options) {
  const generatedAt = (options && options.generatedAt) || new Date().toISOString();
  const preparedTasks = sortTasks(flattenAllTasks(tasksPayload).map(function(task) {
    return prepareTask(task, defaultOverrides());
  }).filter(function(task) {
    return task.lane === 'Next Actions';
  }));
  const grouped = groupExecutionTasks(preparedTasks);
  const details = [];
  const taskIndex = {};

  grouped.forEach(function(group) {
    const tasks = sortTasks(group.tasks);
    const first = tasks[0];
    const clusterId = 'execution-' + clusterIdForGroup(group, tasks);
    const detailFile = path.join('by-id', detailFileName(clusterId));
    const commonReason = group.reasons[0] ? group.reasons[0].text : 'conservative execution grouping';
    const detail = {
      cluster_id: clusterId,
      display_name: executionClusterDisplayName(group, tasks),
      aliases: clusterAliases(tasks, { display_name: executionClusterDisplayName(group, tasks) }),
      generated_at: generatedAt,
      source_tasks_synced_at: tasksPayload.syncedAt || null,
      source_tasks_fetched_at: tasksPayload.syncedAt || null,
      lane: 'Next Actions',
      kind: executionClusterKind(group, first),
      summary: '',
      blocking_party: 'Chris',
      priority_score: executionPriorityScore(tasks, executionClusterKind(group, first)),
      confidence: executionClusterConfidence(group),
      group_reasons: executionGroupReasons(group, commonReason),
      task_count: tasks.length,
      detail_file: detailFile,
      stale_after_seconds: 600,
      tasks: []
    };

    detail.summary = executionClusterSummary(detail, first);
    detail.tasks = tasks.map(function(task) {
      const groupReason = group.reasons.find(function(entry) { return entry.task_id === task.task_id; });
      const taskDetail = {
        task_id: task.task_id,
        content: task.content,
        description: task.description,
        project_name: task.project_name,
        section_name: task.section_name,
        labels: task.labels,
        priority: task.priority,
        due_date: task.due_date,
        due_string: task.due_string,
        created_at: task.created_at,
        updated_at: task.updated_at,
        why_in_cluster: executionTaskWhyInCluster(group, task, groupReason && groupReason.text),
        mailbox_hint: executionMailboxHint(task),
        preferred_reply_action: task.trace.provider === 'microsoft' ? 'reply' : 'draft',
        trace: {
          source_type: task.trace.source_type,
          mailbox: task.trace.mailbox,
          provider: task.trace.provider,
          subject_hint: task.trace.subject_hint,
          normalized_subject_lookup_key: task.trace.normalized_subject_lookup_key,
          thread_lookup_method: task.trace.thread_lookup_method,
          msg_id: task.trace.msg_id,
          msg_id_is_secondary_only: task.trace.msg_id_is_secondary_only,
          traceability_confidence: task.trace.traceability_confidence,
          notes: task.trace.notes
        },
        traceability_confidence: task.trace.traceability_confidence
      };

      taskIndex[task.task_id] = {
        cluster_id: detail.cluster_id,
        display_name: detail.display_name,
        detail_file: detail.detail_file,
        lane: detail.lane,
        kind: detail.kind,
        subject_hint: task.trace.subject_hint,
        normalized_subject_lookup_key: task.trace.normalized_subject_lookup_key,
        mailbox: task.trace.mailbox,
        mailbox_hint: taskDetail.mailbox_hint,
        provider: task.trace.provider,
        thread_lookup_method: task.trace.thread_lookup_method,
        msg_id: task.trace.msg_id,
        msg_id_is_secondary_only: task.trace.msg_id_is_secondary_only,
        traceability_confidence: task.trace.traceability_confidence,
        preferred_reply_action: taskDetail.preferred_reply_action,
        why_in_cluster: taskDetail.why_in_cluster
      };

      return taskDetail;
    });

    details.push(detail);
  });

  details.sort(function(left, right) {
    if (right.priority_score !== left.priority_score) return right.priority_score - left.priority_score;
    if (right.task_count !== left.task_count) return right.task_count - left.task_count;
    return left.display_name.localeCompare(right.display_name);
  });

  const summary = {
    generated_at: generatedAt,
    source_tasks_synced_at: tasksPayload.syncedAt || null,
    task_count: preparedTasks.length,
    cluster_count: details.length,
    stale_after_seconds: 600,
    clusters: details.map(function(detail) {
      return {
        cluster_id: detail.cluster_id,
        display_name: detail.display_name,
        aliases: detail.aliases,
        lane: detail.lane,
        kind: detail.kind,
        summary: detail.summary,
        blocking_party: detail.blocking_party,
        priority_score: detail.priority_score,
        task_count: detail.task_count,
        confidence: detail.confidence,
        detail_file: detail.detail_file
      };
    })
  };

  const debugSummary = [
    '# Taskbot Execution Clusters',
    '',
    'Generated at: ' + generatedAt,
    'Source tasks synced at: ' + (tasksPayload.syncedAt || 'unknown'),
    'Task count: ' + preparedTasks.length,
    'Cluster count: ' + details.length,
    '',
    '## Clusters'
  ].concat(details.map(function(detail) {
    return '- ' + summaryLine(detail);
  })).join('\n') + '\n';

  return {
    summary: summary,
    task_index: taskIndex,
    details: details,
    debug_summary: debugSummary
  };
}

function clusterIdForGroup(group, tasks) {
  return clusterId(group, tasks);
}

function mostCommon(values) {
  const counts = {};
  values.forEach(function(value) {
    if (!value) return;
    counts[value] = (counts[value] || 0) + 1;
  });
  return Object.keys(counts).sort(function(left, right) {
    if (counts[right] !== counts[left]) return counts[right] - counts[left];
    return left.localeCompare(right);
  })[0] || null;
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tempPath, filePath);
}

function writeOverlayFiles(baseDir, overlay) {
  const byIdDir = path.join(baseDir, 'by-id');
  fs.mkdirSync(byIdDir, { recursive: true });

  const expectedFiles = new Set();
  overlay.details.forEach(function(detail) {
    const filePath = path.join(baseDir, detail.detail_file);
    expectedFiles.add(filePath);
    writeJsonAtomic(filePath, detail);
  });

  if (fs.existsSync(byIdDir)) {
    fs.readdirSync(byIdDir).forEach(function(name) {
      if (path.extname(name) !== '.json') return;
      const filePath = path.join(byIdDir, name);
      if (!expectedFiles.has(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
  }

  writeJsonAtomic(path.join(baseDir, 'summary.json'), overlay.summary);
  writeJsonAtomic(path.join(baseDir, 'task-index.json'), overlay.task_index);
  writeJsonAtomic(path.join(baseDir, 'debug-summary.json'), {
    generated_at: overlay.summary.generated_at,
    source_tasks_synced_at: overlay.summary.source_tasks_synced_at,
    cluster_lines: overlay.details.map(function(detail) {
      return summaryLine(detail);
    })
  });
  fs.writeFileSync(path.join(baseDir, 'debug-summary.md'), overlay.debug_summary);
}

module.exports = {
  buildOverlay,
  buildExecutionOverlay,
  defaultOverrides,
  normalizeOverrides,
  writeOverlayFiles
};
