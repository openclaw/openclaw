const fs = require('fs');
const path = require('path');

const THREAD_FETCH_TIMEOUT_MS = 45_000;
const MICROSOFT_MAILBOX_KEYS = new Set(['chris', 'stitch']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readBasicNextTaskBrief(options) {
  const taskbotDir = options.taskbotDir;
  const briefPath = path.join(taskbotDir, 'work-next-brief.md');
  const packetPath = path.join(taskbotDir, 'work-next.json');

  if (fs.existsSync(briefPath)) {
    const brief = fs.readFileSync(briefPath, 'utf8');
    if (brief.trim()) {
      return {
        ok: true,
        source: 'work-next-brief.md',
        brief
      };
    }
  }

  if (!fs.existsSync(packetPath)) {
    throw createResolverError('missing_work_next_packet', 'Next-task work packet is missing.', 503, {
      brief_path: briefPath,
      packet_path: packetPath
    });
  }

  return {
    ok: true,
    source: 'work-next.json',
    brief: formatWorkBrief(readJson(packetPath))
  };
}

function createResolverError(code, message, statusCode, details) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode || 500;
  error.details = details || {};
  return error;
}

function mailboxKey(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'chris' || normalized === 'chris@prestigiocustom.com') return 'chris';
  if (normalized === 'stitch' || normalized === 'stitch@prestigiocustom.com') return 'stitch';
  if (normalized === 'gmail' || normalized === 'chris91744@gmail.com') return 'gmail';
  return normalized;
}

function siblingMicrosoftMailbox(key) {
  if (key === 'chris') return 'stitch';
  if (key === 'stitch') return 'chris';
  return null;
}

function extractDescriptionSection(description, heading) {
  const text = String(description || '');
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingPattern = new RegExp('^' + escapedHeading + ':\\s*$', 'gim');
  const match = headingPattern.exec(text);
  if (!match) return null;

  const afterHeading = text.slice(match.index + match[0].length);
  const nextHeading = afterHeading.search(/^\s*(Subject|Summary|Latest message|What they need|Bottom line|Next action):\s*$/gim);
  const sectionText = nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading;
  const cleaned = sectionText
    .replace(/\[msgId:[\s\S]*$/i, '')
    .trim();
  return cleaned || null;
}

function buildMailroomPacket(task, threadFetch) {
  const description = task.description || '';
  const summary = extractDescriptionSection(description, 'Summary');
  const latestMessage = extractDescriptionSection(description, 'Latest message');
  const whatTheyNeed = extractDescriptionSection(description, 'What they need');
  const bottomLine = extractDescriptionSection(description, 'Bottom line');
  const nextAction = extractDescriptionSection(description, 'Next action');
  const hasStructuredPacket = Boolean(summary || latestMessage || whatTheyNeed || bottomLine || nextAction);

  return {
    has_structured_packet: hasStructuredPacket,
    subject: threadFetch && threadFetch.subject ? threadFetch.subject : null,
    summary,
    latest_message: latestMessage,
    what_they_need: whatTheyNeed,
    bottom_line: bottomLine,
    next_action: nextAction
  };
}

function loadFreshStatus(todoistDir) {
  const statusPath = path.join(todoistDir, 'clusters', 'build-status.json');
  if (!fs.existsSync(statusPath)) {
    throw createResolverError('missing_build_status', 'Todoist cluster build status is missing.', 503, {
      status_path: statusPath
    });
  }

  const status = readJson(statusPath);
  if (!status.success || !status.fresh) {
    throw createResolverError('stale_overlay', 'Todoist cluster overlay is not fresh.', 503, {
      status
    });
  }

  return status;
}

function loadExecutionOverlay(taskbotDir) {
  const executionDir = path.join(taskbotDir, 'execution-clusters');
  const summaryPath = path.join(executionDir, 'summary.json');
  const taskIndexPath = path.join(executionDir, 'task-index.json');

  if (!fs.existsSync(summaryPath) || !fs.existsSync(taskIndexPath)) {
    throw createResolverError('missing_execution_overlay', 'Task execution overlay is missing.', 503, {
      summary_path: summaryPath,
      task_index_path: taskIndexPath
    });
  }

  return {
    executionDir,
    summary: readJson(summaryPath),
    taskIndex: readJson(taskIndexPath)
  };
}

function loadSessionState(taskbotDir) {
  const sessionPath = path.join(taskbotDir, 'session.json');
  if (!fs.existsSync(sessionPath)) {
    return {
      completedTaskIds: new Set(),
      skippedTaskIds: new Set()
    };
  }

  try {
    const session = readJson(sessionPath);
    return {
      completedTaskIds: new Set((session.completed_task_ids || []).map(String)),
      skippedTaskIds: new Set((session.skipped_task_ids || []).map(String))
    };
  } catch (_) {
    return {
      completedTaskIds: new Set(),
      skippedTaskIds: new Set()
    };
  }
}

function loadDetail(executionDir, detailFile) {
  if (!detailFile) {
    throw createResolverError('missing_detail_file', 'Execution cluster is missing its detail file pointer.', 500);
  }

  const detailPath = path.join(executionDir, detailFile);
  if (!fs.existsSync(detailPath)) {
    throw createResolverError('missing_cluster_detail', 'Execution cluster detail file is missing.', 503, {
      detail_path: detailPath
    });
  }

  return readJson(detailPath);
}

function findCluster(summary, clusterId) {
  if (!Array.isArray(summary.clusters)) {
    throw createResolverError('invalid_execution_summary', 'Execution summary is missing clusters.', 503);
  }

  if (!clusterId) {
    return summary.clusters[0] || null;
  }

  return summary.clusters.find(function(cluster) {
    return cluster.cluster_id === clusterId;
  }) || null;
}

function taskPosition(detail, taskId, sessionState, taskFilter) {
  const tasks = Array.isArray(detail.tasks) ? detail.tasks : [];
  const includeTask = typeof taskFilter === 'function' ? taskFilter : function() { return true; };
  let index = -1;

  if (taskId) {
    index = tasks.findIndex(function(task) { return task.task_id === taskId; });
  } else {
    index = tasks.findIndex(function(task) {
      return includeTask(task)
        && !sessionState.completedTaskIds.has(String(task.task_id))
        && !sessionState.skippedTaskIds.has(String(task.task_id));
    });
  }

  if (index < 0 || !tasks[index]) {
    throw createResolverError(taskId ? 'task_not_in_cluster' : 'cluster_tasks_exhausted', 'No available task was found in the resolved execution cluster.', taskId ? 404 : 409, {
      cluster_id: detail.cluster_id,
      task_id: taskId
    });
  }

  return {
    task: tasks[index],
    index,
    total: tasks.length
  };
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function isTodayOrOverdue(task, today) {
  if (!task || !task.due_date) return false;
  return task.due_date <= today;
}

function detailHasAvailableTodayTask(detail, sessionState, today) {
  return (Array.isArray(detail.tasks) ? detail.tasks : []).some(function(task) {
    return isTodayOrOverdue(task, today)
      && !sessionState.completedTaskIds.has(String(task.task_id))
      && !sessionState.skippedTaskIds.has(String(task.task_id));
  });
}

function doneForTodayPacket(status, overlay, sessionState) {
  const today = todayDate();
  const clusters = Array.isArray(overlay.summary.clusters) ? overlay.summary.clusters : [];
  let lookaheadCount = 0;

  clusters.forEach(function(cluster) {
    const detail = loadDetail(overlay.executionDir, cluster.detail_file);
    (Array.isArray(detail.tasks) ? detail.tasks : []).forEach(function(task) {
      if (sessionState.completedTaskIds.has(String(task.task_id))
        || sessionState.skippedTaskIds.has(String(task.task_id))) {
        return;
      }
      if (!isTodayOrOverdue(task, today)) {
        lookaheadCount += 1;
      }
    });
  });

  return {
    ok: true,
    done_for_today: true,
    generated_at: new Date().toISOString(),
    source_tasks_synced_at: status.source_tasks_synced_at,
    overlay_generated_at: overlay.summary.generated_at,
    packet: {
      kind: 'done_for_today',
      title: 'Today’s Next Actions are done',
      message: 'Nice work. Today’s Next Actions are clear.',
      next_prompt: lookaheadCount > 0
        ? 'Want to look ahead, or call it for now?'
        : 'Want to call it for now?',
      lookahead_count: lookaheadCount,
      allowed_task_actions: ['look_ahead', 'call_it', 'change_cluster']
    }
  };
}

function buildThreadFetch(task) {
  const trace = task.trace || {};
  const provider = trace.provider || 'unknown';
  const subject = trace.subject_hint || null;
  const key = mailboxKey(task.mailbox_hint || trace.mailbox);

  if (!subject) {
    return {
      required: false,
      reason: 'Task has no preserved email subject.',
      subject: null,
      request: null,
      rescue_policy: null
    };
  }

  if (provider !== 'microsoft') {
    return {
      required: false,
      reason: provider === 'gmail'
        ? 'Gmail task has a subject hint, but this helper does not support threaded Gmail reply-all fetches.'
        : 'Task provider is not a Microsoft mailbox.',
      subject,
      request: null,
      rescue_policy: null
    };
  }

  if (!MICROSOFT_MAILBOX_KEYS.has(key)) {
    return {
      required: true,
      reason: 'Microsoft task has a subject but no supported starting mailbox.',
      subject,
      request: null,
      rescue_policy: null
    };
  }

  const request = {
    action: 'fetch_thread_by_subject',
    mailbox: key,
    subject,
    contextSubject: subject,
    sourceTaskText: task.content || '',
    timeoutMs: THREAD_FETCH_TIMEOUT_MS
  };

  return {
    required: true,
    default_use: 'Use this request only for explicit thread verification or to get the current message id needed for a threaded reply draft. Do not fetch the thread just to brief a task when the Mailroom task packet has a usable summary.',
    subject,
    request,
    rescue_policy: {
      sibling_mailbox: siblingMicrosoftMailbox(key),
      retry_sibling_on: ['missing_response', 'timeout', 'message_count:0'],
      do_not_retry_sibling_on: ['ambiguous_thread'],
      ambiguous_thread_policy: 'Surface candidates from the authoritative mailbox instead of guessing.'
    },
    message_id_policy: 'Ignore stored msg_id for normal opening; subject search is primary.'
  };
}

function buildPresentation(task, threadFetch) {
  const subject = threadFetch && threadFetch.subject ? threadFetch.subject : null;
  return {
    title: task.content || '',
    subject_copy_line: subject ? 'Subject: ' + subject : null,
    telegram_subject_inline_code: subject ? '`Subject: ' + subject + '`' : null,
    telegram_subject_fenced_code: subject ? '```text\nSubject: ' + subject + '\n```' : null,
    rules: [
      'Use the Mailroom task packet as the default briefing source.',
      'Give Chris the copyable subject line so he can pull up the thread himself.',
      'Fetch the thread only when Chris asks for verification, when the task packet is ambiguous, or when a threaded draft needs a current message id.',
      'Keep retrieval/debug fields hidden unless Chris asks why the thread was chosen.'
    ]
  };
}

function compactLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatWorkBrief(resolved) {
  if (resolved && resolved.done_for_today && resolved.packet) {
    const packet = resolved.packet;
    const lines = [
      '**✅ ' + compactLine(packet.title || 'Today’s Next Actions are done') + '**',
      '',
      compactLine(packet.message || 'Nice work. Today’s Next Actions are clear.'),
      '',
      compactLine(packet.next_prompt || 'Want to look ahead, or call it for now?')
    ];
    return lines.join('\n') + '\n';
  }

  if (!resolved || resolved.ok !== true || !resolved.packet) {
    return 'The next-task packet is not available right now. Please refresh Todoist and try again.';
  }

  const packet = resolved.packet;
  const task = packet.task || {};
  const mailroom = packet.mailroom_packet || {};
  const presentation = packet.presentation || {};
  const title = compactLine(presentation.title || task.content || 'Next task');
  const subjectLine = presentation.subject_copy_line
    ? compactLine(presentation.subject_copy_line)
    : null;
  const summary = compactLine(mailroom.summary || task.content || '');
  const lead = compactLine(mailroom.latest_message || summary);
  const bottomLine = compactLine(mailroom.bottom_line || summary);
  const nextAction = compactLine(mailroom.next_action || mailroom.what_they_need || '');

  const lines = [
    '**📩 ' + title + '**'
  ];

  if (subjectLine) {
    lines.push('', '```text', subjectLine, '```');
  }

  if (lead) {
    lines.push('', lead);
  }

  if (bottomLine) {
    lines.push('', '**Bottom line:** ' + bottomLine);
  }

  if (nextAction) {
    lines.push('**Next step:** ' + nextAction);
  }

  return lines.join('\n') + '\n';
}

function buildTaskPacket(detail, task, position) {
  const threadFetch = buildThreadFetch(task);
  const mailroomPacket = buildMailroomPacket(task, threadFetch);
  return {
    cluster: {
      cluster_id: detail.cluster_id,
      display_name: detail.display_name,
      kind: detail.kind,
      summary: detail.summary,
      task_count: detail.task_count,
      confidence: detail.confidence
    },
    position: {
      index: position.index + 1,
      total: position.total,
      label: 'Task ' + (position.index + 1) + ' of ' + position.total
    },
    task: {
      task_id: task.task_id,
      content: task.content,
      description: task.description,
      project_name: task.project_name,
      priority: task.priority,
      due_date: task.due_date,
      due_string: task.due_string,
      why_in_cluster: task.why_in_cluster,
      traceability_confidence: task.traceability_confidence
    },
    thread_fetch: threadFetch,
    mailroom_packet: mailroomPacket,
    presentation: buildPresentation(task, threadFetch),
    allowed_task_actions: ['brief', 'draft_reply', 'mark_done', 'move_waiting', 'skip', 'change_cluster']
  };
}

function resolveWorkPacket(options) {
  const todoistDir = options.todoistDir;
  const taskbotDir = options.taskbotDir;
  const taskId = options.taskId || null;
  const clusterId = options.clusterId || null;

  const status = loadFreshStatus(todoistDir);
  const overlay = loadExecutionOverlay(taskbotDir);
  const sessionState = loadSessionState(taskbotDir);

  let cluster = null;
  let resolvedTaskId = taskId;
  let detail = null;
  let position = null;

  if (resolvedTaskId) {
    const indexEntry = overlay.taskIndex[resolvedTaskId];
    if (!indexEntry) {
      throw createResolverError('task_not_in_execution_index', 'Task is not in the Next Actions execution index.', 404, {
        task_id: resolvedTaskId
      });
    }
    cluster = findCluster(overlay.summary, indexEntry.cluster_id);
    if (cluster) {
      detail = loadDetail(overlay.executionDir, cluster.detail_file);
      position = taskPosition(detail, resolvedTaskId, sessionState);
    }
  } else {
    let candidateClusters = clusterId
      ? [findCluster(overlay.summary, clusterId)].filter(Boolean)
      : (Array.isArray(overlay.summary.clusters) ? overlay.summary.clusters : []);

    if (!clusterId) {
      const today = todayDate();
      candidateClusters = candidateClusters.filter(function(candidate) {
        const candidateDetail = loadDetail(overlay.executionDir, candidate.detail_file);
        return detailHasAvailableTodayTask(candidateDetail, sessionState, today);
      });

      if (candidateClusters.length === 0) {
        return doneForTodayPacket(status, overlay, sessionState);
      }
    }

    for (let i = 0; i < candidateClusters.length; i += 1) {
      const candidate = candidateClusters[i];
      const candidateDetail = loadDetail(overlay.executionDir, candidate.detail_file);
      try {
        const today = !clusterId ? todayDate() : null;
        const candidatePosition = taskPosition(candidateDetail, null, sessionState, today
          ? function(task) { return isTodayOrOverdue(task, today); }
          : null);
        cluster = candidate;
        detail = candidateDetail;
        position = candidatePosition;
        break;
      } catch (error) {
        if (error.code !== 'cluster_tasks_exhausted') {
          throw error;
        }
      }
    }
  }

  if (!cluster || !detail || !position) {
    throw createResolverError('cluster_not_found', 'No matching execution cluster was found.', 404, {
      cluster_id: clusterId,
      task_id: taskId
    });
  }

  const packet = buildTaskPacket(detail, position.task, position);

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    source_tasks_synced_at: status.source_tasks_synced_at,
    overlay_generated_at: overlay.summary.generated_at,
    packet
  };
}

function resolveClusterMenu(options) {
  const status = loadFreshStatus(options.todoistDir);
  const overlay = loadExecutionOverlay(options.taskbotDir);
  const page = Math.max(1, Number(options.page || 1));
  const pageSize = Math.max(1, Math.min(10, Number(options.pageSize || 5)));
  const clusters = Array.isArray(overlay.summary.clusters) ? overlay.summary.clusters : [];
  const start = (page - 1) * pageSize;

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    source_tasks_synced_at: status.source_tasks_synced_at,
    overlay_generated_at: overlay.summary.generated_at,
    page,
    page_size: pageSize,
    total_clusters: clusters.length,
    has_next_page: start + pageSize < clusters.length,
    clusters: clusters.slice(start, start + pageSize).map(function(cluster, index) {
      return {
        number: start + index + 1,
        cluster_id: cluster.cluster_id,
        display_name: cluster.display_name,
        summary: cluster.summary,
        task_count: cluster.task_count,
        priority_score: cluster.priority_score,
        confidence: cluster.confidence,
        detail_file: cluster.detail_file
      };
    })
  };
}

module.exports = {
  THREAD_FETCH_TIMEOUT_MS,
  formatWorkBrief,
  readBasicNextTaskBrief,
  resolveClusterMenu,
  resolveWorkPacket
};
