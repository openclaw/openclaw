import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { buildJitsiRoomUrl, buildMeetingStartUrl, createRoomId } from "./jitsi-url.js";
import type { CreateRoomInput, JitsiBridgeRoomRecord } from "./types.js";

type RoomStoreFile = {
  rooms: JitsiBridgeRoomRecord[];
};

export class JitsiBridgeRoomStore {
  constructor(
    private readonly stateDir: string,
    private readonly jitsiBaseUrl: string,
    private readonly startBaseUrl?: string,
    private readonly roomTopicFallback = "meeting-briefing",
  ) {}

  get filePath(): string {
    return path.join(this.stateDir, "rooms.json");
  }

  async list(): Promise<JitsiBridgeRoomRecord[]> {
    const data = await this.readStore();
    return [...data.rooms].toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<JitsiBridgeRoomRecord | undefined> {
    const data = await this.readStore();
    return data.rooms.find((room) => room.id === id);
  }

  async create(input: CreateRoomInput): Promise<JitsiBridgeRoomRecord> {
    const data = await this.readStore();
    const now = new Date().toISOString();
    const id = input.id?.trim() || createRoomId(input.topic, this.roomTopicFallback);
    const room: JitsiBridgeRoomRecord = {
      id,
      topic: input.topic?.trim() || undefined,
      jitsiUrl: buildJitsiRoomUrl({
        baseUrl: this.jitsiBaseUrl,
        roomId: id,
        displayName: input.displayName,
      }),
      joinToken: randomBytes(24).toString("hex"),
      displayName: input.displayName,
      inviteEmail: input.inviteEmail,
      realtimeModel: input.realtimeModel,
      briefing: "",
      status: "created",
      createdAt: now,
      updatedAt: now,
    };
    if (this.startBaseUrl) {
      room.startUrl = buildMeetingStartUrl({
        baseUrl: this.startBaseUrl,
        roomId: id,
        joinToken: room.joinToken,
      });
    }
    data.rooms = data.rooms.filter((entry) => entry.id !== id);
    data.rooms.push(room);
    await this.writeStore(data);
    return room;
  }

  async update(
    id: string,
    mutate: (room: JitsiBridgeRoomRecord) => JitsiBridgeRoomRecord,
  ): Promise<JitsiBridgeRoomRecord> {
    const data = await this.readStore();
    const index = data.rooms.findIndex((room) => room.id === id);
    if (index === -1) {
      throw new Error(`Unknown room ${id}`);
    }
    const current = data.rooms[index];
    const next = mutate({ ...current, updatedAt: new Date().toISOString() });
    data.rooms[index] = next;
    await this.writeStore(data);
    return next;
  }

  private async ensureStateDir(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
  }

  private async readStore(): Promise<RoomStoreFile> {
    await this.ensureStateDir();
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RoomStoreFile>;
      return { rooms: Array.isArray(parsed.rooms) ? parsed.rooms : [] };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { rooms: [] };
      }
      throw error;
    }
  }

  private async writeStore(data: RoomStoreFile): Promise<void> {
    await this.ensureStateDir();
    await fs.writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}
