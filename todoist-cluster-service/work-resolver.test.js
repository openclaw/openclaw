const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildExecutionOverlay, writeOverlayFiles } = require('./clusterer');
const {
  THREAD_FETCH_TIMEOUT_MS,
  formatWorkBrief,
  readBasicNextTaskBrief,
  resolveClusterMenu,
  resolveWorkPacket
} = require('./work-resolver');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function task(overrides) {
  return {
    id: overrides.id,
    content: overrides.content,
    description: overrides.description || '',
    project_name: overrides.project_name || 'Next Actions',
    priority: overrides.priority || 1,
    due: overrides.due || null,
    labels: []
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'todoist-work-resolver-'));
  const todoistDir = path.join(root, 'todoist');
  const taskbotDir = path.join(root, 'taskbot');
  const today = new Date().toISOString().slice(0, 10);
  const payload = {
    syncedAt: '2026-04-24T07:00:00.000Z',
    allTasks: [
      task({
        id: 't-1',
        content: 'Reply to Brent about Tigertail OAW revision',
        priority: 4,
        due: { date: today, string: 'today', recurring: false },
        description:
          'Subject: Re: New Tigertail Orders\n\nSummary:\nBrent sent an updated PO and asked us to confirm the OAW revision.\n\nLatest message:\nBrent sent the latest note today with an updated PO attachment.\n\nWhat they need:\nConfirm the sectional OAW is revised to 137 inches.\n\nBottom line:\nThe revision needs acknowledgement before production continues.\n\nNext action:\nReply confirming the 137 inch OAW revision.\n\n[msgId: stale-message-id | chris@prestigiocustom.com]'
      }),
      task({
        id: 't-2',
        content: 'Review GoDaddy renewal notice',
        priority: 2,
        due: { date: today, string: 'today', recurring: false },
        description:
          'Subject: Your product(s) will expire soon. [msgId: gmail-message-id | chris91744@gmail.com]'
      }),
      task({
        id: 'waiting-1',
        content: 'Ask Diana to check a COM receipt',
        project_name: 'Waiting For',
        priority: 4,
        description:
          'Subject: Re: COM receipt [msgId: waiting-message-id | chris@prestigiocustom.com]'
      })
    ]
  };

  const overlay = buildExecutionOverlay(payload, {
    generatedAt: '2026-04-24T07:00:01.000Z'
  });
  writeOverlayFiles(path.join(taskbotDir, 'execution-clusters'), overlay);
  writeJson(path.join(todoistDir, 'clusters', 'build-status.json'), {
    success: true,
    fresh: true,
    source_tasks_synced_at: payload.syncedAt
  });

  return { root, todoistDir, taskbotDir };
}

test('resolveWorkPacket returns a deterministic next-task fetch packet', () => {
  const { root, todoistDir, taskbotDir } = fixture();
  try {
    const result = resolveWorkPacket({ todoistDir, taskbotDir });

    assert.equal(result.ok, true);
    assert.equal(result.packet.task.task_id, 't-1');
    assert.equal(result.packet.position.label, 'Task 1 of 1');
    assert.deepEqual(result.packet.thread_fetch.request, {
      action: 'fetch_thread_by_subject',
      mailbox: 'chris',
      subject: 'Re: New Tigertail Orders',
      contextSubject: 'Re: New Tigertail Orders',
      sourceTaskText: 'Reply to Brent about Tigertail OAW revision',
      timeoutMs: THREAD_FETCH_TIMEOUT_MS
    });
    assert.equal(result.packet.thread_fetch.message_id_policy, 'Ignore stored msg_id for normal opening; subject search is primary.');
    assert.match(result.packet.thread_fetch.default_use, /current message id/);
    assert.equal(result.packet.mailroom_packet.summary, 'Brent sent an updated PO and asked us to confirm the OAW revision.');
    assert.equal(result.packet.mailroom_packet.latest_message, 'Brent sent the latest note today with an updated PO attachment.');
    assert.equal(result.packet.mailroom_packet.what_they_need, 'Confirm the sectional OAW is revised to 137 inches.');
    assert.equal(result.packet.mailroom_packet.bottom_line, 'The revision needs acknowledgement before production continues.');
    assert.equal(result.packet.mailroom_packet.next_action, 'Reply confirming the 137 inch OAW revision.');
    assert.equal(result.packet.presentation.subject_copy_line, 'Subject: Re: New Tigertail Orders');
    assert.match(result.packet.presentation.rules.join(' '), /Mailroom task packet/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('formatWorkBrief returns a small ready-to-send task card', () => {
  const { root, todoistDir, taskbotDir } = fixture();
  try {
    const brief = formatWorkBrief(resolveWorkPacket({ todoistDir, taskbotDir }));

    assert.match(brief, /Reply to Brent about Tigertail OAW revision/);
    assert.match(brief, /```text\nSubject: Re: New Tigertail Orders\n```/);
    assert.match(brief, /Brent sent the latest note today with an updated PO attachment\./);
    assert.match(brief, /\*\*Bottom line:\*\* The revision needs acknowledgement before production continues\./);
    assert.match(brief, /\*\*Next step:\*\* Reply confirming the 137 inch OAW revision\./);
    assert.ok(brief.length < 700);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readBasicNextTaskBrief prefers the lean markdown snapshot without todoist cache', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'todoist-work-brief-'));
  try {
    const taskbotDir = path.join(root, 'taskbot');
    const briefPath = path.join(taskbotDir, 'work-next-brief.md');
    fs.mkdirSync(taskbotDir, { recursive: true });
    fs.writeFileSync(briefPath, '**📩 Reply to Ashley**\n\nConfirm the quote revision.\n', 'utf8');

    const result = readBasicNextTaskBrief({ taskbotDir });

    assert.equal(result.ok, true);
    assert.equal(result.source, 'work-next-brief.md');
    assert.match(result.brief, /Reply to Ashley/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readBasicNextTaskBrief falls back to work-next.json without todoist cache', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'todoist-work-packet-'));
  try {
    const taskbotDir = path.join(root, 'taskbot');
    fs.mkdirSync(taskbotDir, { recursive: true });
    writeJson(path.join(taskbotDir, 'work-next.json'), {
      ok: true,
      packet: {
        task: {
          content: 'Reply to Morgan about COM arrival'
        },
        mailroom_packet: {
          latest_message: 'Morgan asked whether the COM arrived.',
          bottom_line: 'The fabric arrival needs confirmation.',
          next_action: 'Confirm whether receiving has checked it in.'
        },
        presentation: {
          title: 'Reply to Morgan about COM arrival',
          subject_copy_line: 'Subject: COM arrival check'
        }
      }
    });

    const result = readBasicNextTaskBrief({ taskbotDir });

    assert.equal(result.ok, true);
    assert.equal(result.source, 'work-next.json');
    assert.match(result.brief, /Reply to Morgan about COM arrival/);
    assert.match(result.brief, /Subject: COM arrival check/);
    assert.match(result.brief, /The fabric arrival needs confirmation/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveWorkPacket can open a specific task and preserves Gmail as non-threaded', () => {
  const { root, todoistDir, taskbotDir } = fixture();
  try {
    const result = resolveWorkPacket({ todoistDir, taskbotDir, taskId: 't-2' });

    assert.equal(result.ok, true);
    assert.equal(result.packet.task.task_id, 't-2');
    assert.equal(result.packet.thread_fetch.required, false);
    assert.match(result.packet.thread_fetch.reason, /Gmail/);
    assert.equal(result.packet.presentation.subject_copy_line, 'Subject: Your product(s) will expire soon.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveClusterMenu returns paged execution clusters only', () => {
  const { root, todoistDir, taskbotDir } = fixture();
  try {
    const result = resolveClusterMenu({ todoistDir, taskbotDir, pageSize: 1 });

    assert.equal(result.ok, true);
    assert.equal(result.page, 1);
    assert.equal(result.clusters.length, 1);
    assert.equal(result.total_clusters, 2);
    assert.equal(result.has_next_page, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveWorkPacket skips completed and skipped session tasks when picking next', () => {
  const { root, todoistDir, taskbotDir } = fixture();
  try {
    writeJson(path.join(taskbotDir, 'session.json'), {
      completed_task_ids: ['t-1'],
      skipped_task_ids: []
    });

    const result = resolveWorkPacket({ todoistDir, taskbotDir });

    assert.equal(result.ok, true);
    assert.equal(result.packet.task.task_id, 't-2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveWorkPacket celebrates when today is done instead of pulling tomorrow forward', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'todoist-work-resolver-done-'));
  try {
    const todoistDir = path.join(root, 'todoist');
    const taskbotDir = path.join(root, 'taskbot');
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const payload = {
      syncedAt: '2026-04-24T07:00:00.000Z',
      allTasks: [
        task({
          id: 'future-1',
          content: 'Pay Citi card tomorrow',
          priority: 4,
          due: { date: tomorrow, string: 'tomorrow', recurring: false },
          description: 'Subject: Citi payment reminder [msgId: future-message-id | chris91744@gmail.com]'
        })
      ]
    };
    const overlay = buildExecutionOverlay(payload, {
      generatedAt: '2026-04-24T07:00:01.000Z'
    });
    writeOverlayFiles(path.join(taskbotDir, 'execution-clusters'), overlay);
    writeJson(path.join(todoistDir, 'clusters', 'build-status.json'), {
      success: true,
      fresh: true,
      source_tasks_synced_at: payload.syncedAt
    });

    const result = resolveWorkPacket({ todoistDir, taskbotDir });

    assert.equal(result.ok, true);
    assert.equal(result.done_for_today, true);
    assert.equal(result.packet.kind, 'done_for_today');
    assert.match(result.packet.message, /clear/);
    assert.equal(result.packet.lookahead_count, 1);
    assert.match(formatWorkBrief(result), /Today’s Next Actions are done/);
    assert.match(formatWorkBrief(result), /Want to look ahead, or call it/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveWorkPacket fails closed when overlay is stale', () => {
  const { root, todoistDir, taskbotDir } = fixture();
  try {
    writeJson(path.join(todoistDir, 'clusters', 'build-status.json'), {
      success: true,
      fresh: false,
      source_tasks_synced_at: 'old'
    });

    assert.throws(
      () => resolveWorkPacket({ todoistDir, taskbotDir }),
      /not fresh/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
