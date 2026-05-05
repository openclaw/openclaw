const test = require('node:test');
const assert = require('node:assert/strict');

const { buildExecutionOverlay, buildOverlay } = require('./clusterer');

function task(overrides) {
  return {
    id: overrides.id,
    content: overrides.content,
    description: overrides.description || '',
    project_name: overrides.project_name || 'Next Actions',
    priority: overrides.priority || 1,
    due: overrides.due || null,
    labels: [],
    parent_id: null
  };
}

test('buildExecutionOverlay only includes Next Actions and groups exact subject matches', () => {
  const payload = {
    syncedAt: '2026-04-10T17:00:00.000Z',
    allTasks: [
      task({
        id: 't-1',
        content: 'Reply to Holly about outdoor furniture timeline',
        priority: 3,
        due: { date: '2026-04-10', string: 'today', recurring: false },
        description:
          'Subject: Re: Prestigio Quote: Personal / Outdoor Furniture — $14,870 [msgId: stale-1 | stitch@prestigiocustom.com]'
      }),
      task({
        id: 't-2',
        content: 'Confirm turnaround for Holly Baril outdoor order',
        priority: 2,
        due: { date: '2026-04-11', string: 'tomorrow', recurring: false },
        description:
          'Subject: Prestigio Quote: Personal / Outdoor Furniture — $14,870 [msgId: stale-2 | stitch@prestigiocustom.com]'
      }),
      task({
        id: 't-3',
        content: 'Reply to Mary Hall about quote adders',
        priority: 2,
        description:
          'Subject: Re: Mary Hall bedding quote [msgId: stale-3 | chris@prestigiocustom.com]'
      }),
      task({
        id: 't-4',
        content: 'Ask Diana to check the Hill Rd fabric receipt',
        project_name: 'Waiting For',
        priority: 3,
        description:
          'Subject: Hill Rd fabric receipt [msgId: stale-4 | chris@prestigiocustom.com]'
      })
    ]
  };

  const overlay = buildExecutionOverlay(payload, {
    generatedAt: '2026-04-10T17:01:00.000Z'
  });

  assert.equal(overlay.summary.task_count, 3);
  assert.equal(overlay.summary.cluster_count, 2);

  const threadCluster = overlay.details.find((detail) =>
    detail.tasks.some((entry) => entry.task_id === 't-1'),
  );
  assert.ok(threadCluster);
  assert.equal(threadCluster.kind, 'thread_cluster');
  assert.equal(threadCluster.task_count, 2);
  assert.deepEqual(
    threadCluster.tasks.map((entry) => entry.task_id).sort(),
    ['t-1', 't-2'],
  );

  const singleton = overlay.details.find((detail) =>
    detail.tasks.some((entry) => entry.task_id === 't-3'),
  );
  assert.ok(singleton);
  assert.equal(singleton.kind, 'task_singleton');
  assert.equal(singleton.task_count, 1);

  assert.equal(overlay.task_index['t-1'].mailbox_hint, 'stitch');
  assert.equal(overlay.task_index['t-3'].mailbox_hint, 'chris');
  assert.equal(overlay.task_index['t-1'].preferred_reply_action, 'reply');
  assert.equal(overlay.task_index['t-3'].msg_id_is_secondary_only, true);
  assert.equal(overlay.task_index['t-4'], undefined);
});

test('buildExecutionOverlay keeps fuzzy-looking tasks separate without an exact-safe key', () => {
  const payload = {
    syncedAt: '2026-04-10T17:00:00.000Z',
    allTasks: [
      task({
        id: 'a',
        content: 'Reply to Jennifer Miller Studio about bed receipt',
        description:
          'Subject: Re: Quote QU-0443 from Prestigio Custom Furniture for Jennifer Miller Studio [msgId: a | chris@prestigiocustom.com]'
      }),
      task({
        id: 'b',
        content: 'Reply to Jennifer Miller Studio about armchairs',
        description:
          'Subject: Re: Quote QU-0520 from Prestigio Custom Furniture for Jennifer Miller Studio [msgId: b | chris@prestigiocustom.com]'
      })
    ]
  };

  const overlay = buildExecutionOverlay(payload, {
    generatedAt: '2026-04-10T17:01:00.000Z'
  });

  assert.equal(overlay.summary.cluster_count, 2);
  assert.equal(overlay.details[0].task_count, 1);
  assert.equal(overlay.details[1].task_count, 1);
  assert.match(overlay.details[0].tasks[0].why_in_cluster, /separate|exact/i);
  assert.match(overlay.details[1].tasks[0].why_in_cluster, /separate|exact/i);
});

test('buildOverlay strips human summary prose from structured subject hints', () => {
  const payload = {
    syncedAt: '2026-04-21T22:00:00.000Z',
    allTasks: [
      task({
        id: 'messy-1',
        content: 'Ask Jay to revise Bedroom 3 headboard/rails drawing per Brandon markups (McLain Flats)',
        project_name: 'Waiting For',
        description:
          'Subject: Re: Prestigio Drawing: Bedroom 3 / (2) Fully Upholstered Headboard & Rails / 227121 — McLain Flats. Brandon sent markups for revisions; delegate drafting updates to Jay and return revised drawing for approval. [msgId: stale-1 | stitch@prestigiocustom.com]'
      }),
      task({
        id: 'messy-2',
        content: 'Ask Diana to coordinate zipper lengths + cushion fabric direction for Grammar seat cushions',
        project_name: 'Waiting For',
        description:
          'Subject: FW: Seat cushions. Dalia/Kayte requested help confirming zipper lengths for throw/back cushions and in-person review of seat cushion fabric direction next week. Delegate coordination/response to Diana. [msgId: stale-2 | chris@prestigiocustom.com]'
      })
    ]
  };

  const overlay = buildOverlay(payload, {
    generatedAt: '2026-04-21T22:01:00.000Z'
  });

  assert.equal(
    overlay.task_index['messy-1'].subject_hint,
    'Re: Prestigio Drawing: Bedroom 3 / (2) Fully Upholstered Headboard & Rails / 227121 — McLain Flats',
  );
  assert.equal(
    overlay.task_index['messy-2'].subject_hint,
    'FW: Seat cushions',
  );
});
