import assert from "node:assert/strict";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [root, expected = "green"] = process.argv.slice(2);
const { default: plugin } = await import(
  pathToFileURL(path.join(root, "dist/extensions/imap/index.js"))
);
const { createPluginStateSyncKeyedStore } = await import(
  pathToFileURL(path.join(root, "dist/plugin-sdk/plugin-state-store-runtime.js"))
);
const stores = new Map();
const openKeyedStore = (options) => {
  if (!stores.has(options.namespace)) {
    stores.set(options.namespace, createPluginStateSyncKeyedStore("imap", options));
  }
  return stores.get(options.namespace);
};
const cursors = openKeyedStore({
  namespace: "cursor",
  maxEntries: 256,
  overflowPolicy: "reject-new",
});
cursors.register("fixture", { uidValidity: "7", lastSeenUid: 0, updatedAt: Date.now() });
const headers = (uid, sender = "sender@example.test") => [
  `From: ${sender}`,
  "To: recipient+proof-token@example.test",
  `Subject: Mail ${uid}`,
  `Message-ID: <mail-${uid}@example.test>`,
  "MIME-Version: 1.0",
];
const message = (uid, content, sender) =>
  Buffer.from([...headers(uid, sender), ...content].join("\r\n"));
const messages = [
  message(1, ["Content-Type: text/plain", "", "Plain control."]),
  message(2, [
    'Content-Type: multipart/alternative; boundary="boundary"',
    "",
    "--boundary",
    "Content-Type: text/plain",
    "",
    "Multipart control.",
    "--boundary",
    "Content-Type: text/html",
    "",
    "<p>Multipart&apos;s control.</p>",
    "--boundary--",
  ]),
  message(3, ["Content-Type: text/plain", "", "Denied control."], "denied@example.test"),
  message(4, ["Content-Type: text/html", "", "<p>Sheena&apos;s expert advice.</p>"]),
  message(5, ["Content-Type: text/plain", "", "Later mail."]),
];
const sockets = new Set();
const commands = [];
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.write("* OK local mailbox ready\r\n");
  let pending = "";
  socket.on("data", (data) => {
    pending += data.toString();
    while (pending.includes("\r\n")) {
      const end = pending.indexOf("\r\n");
      const line = pending.slice(0, end);
      pending = pending.slice(end + 2);
      const [tag, command, ...args] = line.split(" ");
      commands.push(command);
      const done = () => socket.write(`${tag} OK completed\r\n`);
      if (command === "CAPABILITY") {
        socket.write("* CAPABILITY IMAP4rev1\r\n");
      } else if (command === "LOGIN" || command === "NOOP") {
        done();
        continue;
      } else if (command === "LIST") {
        socket.write('* LIST () "/" "INBOX"\r\n');
      } else if (command === "LSUB") {
        socket.write('* LSUB () "/" "INBOX"\r\n');
      } else if (command === "SELECT" || command === "EXAMINE") {
        socket.write(
          `* FLAGS (\\Seen)\r\n* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY 7] stable\r\n* OK [UIDNEXT 6] next\r\n`,
        );
      } else if (command === "UID" && args[0] === "FETCH") {
        const start = Number(args[1].split(":")[0]);
        for (let index = messages.length - 1; index >= 0; index--) {
          const uid = index + 1;
          if (uid < start && start <= messages.length) {
            continue;
          }
          if (start > messages.length && uid !== messages.length) {
            continue;
          }
          const source = messages[index];
          socket.write(
            `* ${uid} FETCH (UID ${uid} INTERNALDATE "17-Sep-2026 00:00:00 +0000" RFC822.SIZE ${source.length} BODY[] {${source.length}}\r\n`,
          );
          socket.write(source);
          socket.write(")\r\n");
        }
      } else if (command === "LOGOUT") {
        socket.write("* BYE closing\r\n");
        done();
        socket.end();
        continue;
      } else {
        socket.write(`${tag} BAD unsupported ${command}\r\n`);
        continue;
      }
      done();
    }
  });
});
await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const dispatched = [];
const logs = [];
let completed = Promise.withResolvers();
const logger = Object.fromEntries(
  ["info", "warn", "error", "debug"].map((level) => [
    level,
    (text) => {
      logs.push(text);
      if (text.includes("sweep failed=") || text.includes("lastSweep=")) {
        completed.resolve();
      }
    },
  ]),
);
let service;
plugin.register({
  registrationMode: "full",
  pluginConfig: {
    accounts: {
      fixture: {
        host: "127.0.0.1",
        port: server.address().port,
        secure: false,
        user: "fixture",
        password: "synthetic",
        agentId: "main",
        allowedSenders: ["sender@example.test"],
        addressTokens: [{ token: "proof-token", senders: ["sender@example.test"] }],
        watch: { mode: "interval", pollSeconds: 3600 },
      },
    },
  },
  runtime: {
    state: { openKeyedStore },
    hooks: {
      dispatchHookAgentTurn: async (turn) => {
        dispatched.push(turn);
        return { ok: true, runId: `run-${dispatched.length}` };
      },
    },
  },
  registerService: (registered) => {
    assert.equal(registered.id, "imap-watch");
    service = registered;
  },
});
const timer = setTimeout(
  () => completed.reject(new Error(`service deadline: ${JSON.stringify({ commands, logs })}`)),
  15000,
);
try {
  service.start({ logger, serviceHealth: { clearFailure() {}, reportFailure: completed.reject } });
  await completed.promise;
  const cursor = cursors.lookup("fixture");
  const subjects = dispatched.map((turn) => turn.sessionKey);
  console.log(
    JSON.stringify(
      {
        expected,
        cursor,
        subjects,
        messages: dispatched.map((turn) => turn.message),
        logs,
        commands,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(
    subjects,
    (expected === "red" ? [1, 2] : [1, 2, 4, 5]).map((uid) => `hook:imap:fixture:7:${uid}`),
  );
  assert.equal(cursor.lastSeenUid, expected === "red" ? 3 : 5);
  assert.equal(stores.get("skip-count").lookup("fixture:sender-not-allowed").count, 1);
  assert(dispatched[0].message.includes("Plain control."));
  assert(dispatched[1].message.includes("Multipart control."));
  if (expected === "red") {
    assert(logs.some((text) => text.includes("Failed to parse HTML")));
  } else {
    assert(dispatched[2].message.includes("Sheena's expert advice."));
    assert(dispatched[3].message.includes("Later mail."));
    assert(!logs.some((text) => text.includes("sweep failed=")));
    await service.stop();
    completed = Promise.withResolvers();
    service.start({
      logger,
      serviceHealth: { clearFailure() {}, reportFailure: completed.reject },
    });
    await completed.promise;
    assert.equal(dispatched.length, 4);
    assert.equal(cursors.lookup("fixture").lastSeenUid, 5);
    assert.equal(stores.get("dispatch-claim").entries().length, 5);
    console.log("imap-watch restart preserved cursor and dispatched no duplicate mail");
  }
} finally {
  clearTimeout(timer);
  await service.stop();
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise((resolve) => {
    server.close(resolve);
  });
}
