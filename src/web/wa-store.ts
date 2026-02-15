import {
  type BaileysEventEmitter,
  type Chat,
  type Contact,
  type WAMessage,
  jidNormalizedUser,
  toNumber,
} from "@whiskeysockets/baileys";
import fsSync from "node:fs";

export interface BaileysStore {
  chats: { [jid: string]: Chat };
  contacts: { [id: string]: Contact };
  messages: { [jid: string]: { [msgId: string]: WAMessage } };
  bind: (ev: BaileysEventEmitter) => void;
  writeToFile: (path: string) => void;
  readFromFile: (path: string) => void;
}

export function makeInMemoryStore(config: { logger?: any }): BaileysStore {
  const chats: BaileysStore["chats"] = {};
  const contacts: BaileysStore["contacts"] = {};
  const messages: BaileysStore["messages"] = {};

  const bind = (ev: BaileysEventEmitter) => {
    ev.on(
      "messaging-history.set",
      ({ chats: newChats, contacts: newContacts, messages: newMessages, isLatest }) => {
        if (isLatest) {
          // Option: clear existing? For now, we merge.
        }
        for (const c of newChats) {
          const id = jidNormalizedUser(c.id ?? "");
          chats[id] = Object.assign(chats[id] || {}, c);
        }
        for (const c of newContacts) {
          const id = jidNormalizedUser(c.id ?? "");
          contacts[id] = Object.assign(contacts[id] || {}, c);
        }
        for (const m of newMessages) {
          const jid = m.key.remoteJid;
          const msgId = m.key.id;
          if (jid && msgId) {
            const normJid = jidNormalizedUser(jid);
            if (!messages[normJid]) messages[normJid] = {};
            messages[normJid][msgId] = m;
          }
        }
      },
    );

    ev.on("contacts.upsert", (updates) => {
      for (const c of updates) {
        const id = jidNormalizedUser(c.id ?? "");
        contacts[id] = Object.assign(contacts[id] || {}, c);
      }
    });

    ev.on("contacts.update", (updates) => {
      for (const update of updates) {
        const id = jidNormalizedUser(update.id!);
        if (contacts[id]) {
          Object.assign(contacts[id], update);
        }
      }
    });

    ev.on("chats.upsert", (updates) => {
      for (const c of updates) {
        const id = jidNormalizedUser(c.id ?? "");
        chats[id] = Object.assign(chats[id] || {}, c);
      }
    });

    ev.on("chats.update", (updates) => {
      for (const update of updates) {
        const id = jidNormalizedUser(update.id!);
        if (chats[id]) {
          Object.assign(chats[id], update);
        }
      }
    });

    ev.on("chats.delete", (deletions) => {
      for (const id of deletions) {
        delete chats[jidNormalizedUser(id)];
      }
    });

    ev.on("messages.upsert", ({ messages: newMessages, type }) => {
      if (type === "append" || type === "notify") {
        for (const m of newMessages) {
          const jid = m.key.remoteJid;
          const msgId = m.key.id;
          if (jid && msgId) {
            const normJid = jidNormalizedUser(jid);
            if (!messages[normJid]) messages[normJid] = {};
            messages[normJid][msgId] = m;

            // Update unread count if notify?
            if (type === "notify" && !m.key.fromMe) {
              const chat = chats[normJid];
              if (chat) {
                chat.unreadCount = (chat.unreadCount || 0) + 1;
              }
            }
          }
        }
      }
    });

    ev.on("messages.update", (updates) => {
      for (const { key, update } of updates) {
        const jid = key.remoteJid;
        if (jid) {
          const normJid = jidNormalizedUser(jid);
          if (messages[normJid] && messages[normJid][key.id!]) {
            Object.assign(messages[normJid][key.id!], update);
          }
        }
      }
    });
  };

  const writeToFile = (path: string) => {
    try {
      const data = { chats, contacts, messages };
      fsSync.writeFileSync(path, JSON.stringify(data, null, 2));
    } catch {
      // ignore write errors
    }
  };

  const readFromFile = (path: string) => {
    try {
      if (fsSync.existsSync(path)) {
        const data = JSON.parse(fsSync.readFileSync(path, { encoding: "utf-8" }));
        Object.assign(chats, data.chats || {});
        Object.assign(contacts, data.contacts || {});
        Object.assign(messages, data.messages || {});
      }
    } catch {
      // ignore read errors
    }
  };

  return {
    chats,
    contacts,
    messages,
    bind,
    writeToFile,
    readFromFile,
  };
}
