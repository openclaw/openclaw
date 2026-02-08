import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import path from "path";

export interface StoredPoll {
  pollMsgId: string;
  messageSecret: string; // base64
  options: string[];
  question: string;
  chatJid: string;
  createdAt: number;
}

const STORE_DIR = path.resolve(homedir(), ".openclaw", "state");
const STORE_PATH = path.resolve(STORE_DIR, "whatsapp-polls.json");
const PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let cache: Record<string, StoredPoll> | null = null;

function load(): Record<string, StoredPoll> {
  if (cache) return cache;
  if (existsSync(STORE_PATH)) {
    try {
      cache = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    } catch {
      cache = {};
    }
  } else {
    cache = {};
  }
  prune();
  return cache;
}

function save() {
  if (!cache) return;
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(cache), "utf8");
}

function prune() {
  if (!cache) return;
  const now = Date.now();
  for (const [id, poll] of Object.entries(cache)) {
    if (now - poll.createdAt > PRUNE_MAX_AGE_MS) delete cache[id];
  }
}

export function storePoll(id: string, poll: StoredPoll) {
  const store = load();
  store[id] = poll;
  cache = store;
  save();
}

export function getPoll(id: string): StoredPoll | null {
  const store = load();
  return store[id] ?? null;
}
