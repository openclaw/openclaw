import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { Todo } from "./types.js";

const TODO_DIR = "~/.openclaw";

export class TodoStore {
  private filePath: string;

  constructor(baseDir: string = TODO_DIR) {
    const home = process.env.HOME || process.env.USERPROFILE || "~";
    const expanded = baseDir.replace(/^~/, home);
    this.filePath = resolve(expanded, "todos.jsonl");
  }

  private async ensureDir(): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }

  async load(): Promise<Todo[]> {
    try {
      await this.ensureDir();
      if (!existsSync(this.filePath)) {
        return [];
      }
      const content = await readFile(this.filePath, "utf-8");
      if (!content.trim()) {
        return [];
      }
      return content
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Todo);
    } catch (error) {
      console.error("[todos] Failed to load:", error);
      return [];
    }
  }

  async save(todos: Todo[]): Promise<void> {
    try {
      await this.ensureDir();
      const content = todos.map((t) => JSON.stringify(t)).join("\n");
      await writeFile(this.filePath, content, "utf-8");
    } catch (error) {
      console.error("[todos] Failed to save:", error);
      throw error;
    }
  }

  async create(todo: Todo): Promise<Todo> {
    const todos = await this.load();
    todos.push(todo);
    await this.save(todos);
    return todo;
  }

  async update(id: string, updates: Partial<Todo>): Promise<Todo | null> {
    const todos = await this.load();
    const index = todos.findIndex((t) => t.id === id);
    if (index === -1) {
      return null;
    }
    todos[index] = { ...todos[index], ...updates, updatedAt: Date.now() };
    await this.save(todos);
    return todos[index];
  }

  async delete(id: string): Promise<boolean> {
    const todos = await this.load();
    const filtered = todos.filter((t) => t.id !== id);
    if (filtered.length === todos.length) {
      return false;
    }
    await this.save(filtered);
    return true;
  }

  async findBySession(sessionKey: string): Promise<Todo[]> {
    const todos = await this.load();
    return todos.filter((t) => t.sessionKey === sessionKey);
  }

  async findByStatus(status: string): Promise<Todo[]> {
    const todos = await this.load();
    return todos.filter((t) => t.status === status);
  }
}

// Singleton instance
export const todoStore = new TodoStore();
