const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readTasksPayload } = require('./index');

test('readTasksPayload retries a partial tasks.json read', () => {
  let reads = 0;
  const payload = readTasksPayload({
    filePath: '/tmp/tasks.json',
    retries: 1,
    retryMs: 0,
    wait: () => {},
    readFile: () => {
      reads += 1;
      return reads === 1
        ? '{"syncedAt":"2026-04-29T12:00:00.000Z","allTasks":['
        : '{"syncedAt":"2026-04-29T12:00:00.000Z","allTasks":[]}';
    }
  });

  assert.equal(reads, 2);
  assert.equal(payload.syncedAt, '2026-04-29T12:00:00.000Z');
  assert.deepEqual(payload.allTasks, []);
});

test('transient tasks.json EOF keeps existing work snapshots valid', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoist-clusters-'));
  const script = `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = ${JSON.stringify(tempDir)};
const todoistDir = path.join(root, 'todoist');
const taskbotDir = path.join(root, 'taskbot');
fs.mkdirSync(todoistDir, { recursive: true });
process.env.TODOIST_DIR = todoistDir;
process.env.TASKBOT_DIR = taskbotDir;
process.env.TASKS_FILE = path.join(todoistDir, 'tasks.json');

const validTasks = {
  syncedAt: '2026-04-29T12:00:00.000Z',
  allTasks: [{
    id: 'task-1',
    content: 'Reply to Chris about active sync resilience',
    description: [
      'Subject: Re: Active sync resilience',
      'Summary:',
      'Confirm snapshots stay readable during Todoist rewrites.',
      'Latest message:',
      'Please harden partial reads.',
      'Bottom line:',
      'Do not overwrite good work-next snapshots with transient parse errors.',
      'Next action:',
      'Ship the small retry.'
    ].join('\\n'),
    project_name: 'Next Actions',
    priority: 3,
    due: null,
    labels: [],
    parent_id: null
  }]
};

fs.writeFileSync(process.env.TASKS_FILE, JSON.stringify(validTasks), 'utf8');
const service = require('./index');
service.buildOnce();

const workNextPath = path.join(taskbotDir, 'work-next.json');
const briefPath = path.join(taskbotDir, 'work-next-brief.md');
const before = JSON.parse(fs.readFileSync(workNextPath, 'utf8'));
assert.equal(before.ok, true);
assert.match(fs.readFileSync(briefPath, 'utf8'), /Active sync resilience/);

fs.writeFileSync(process.env.TASKS_FILE, '{"syncedAt":"2026-04-29T12:01:00.000Z","allTasks":[', 'utf8');
service.runBuild('partial tasks.json test');

const metadata = service.readTasksMetadata();
assert.equal(metadata.exists, true);
assert.match(metadata.error, /mid-write|Unexpected end of JSON input/);
const health = service.healthPayload();
assert.equal(health.status, 'degraded');
assert.equal(health.service, 'todoist-clusters');
assert.match(JSON.stringify(health), /tasks.json/);

const after = JSON.parse(fs.readFileSync(workNextPath, 'utf8'));
assert.equal(after.ok, true);
assert.equal(after.packet.task.task_id, 'task-1');
assert.match(fs.readFileSync(briefPath, 'utf8'), /Active sync resilience/);
process.exit(0);
`;

  childProcess.execFileSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    stdio: 'pipe'
  });
});
