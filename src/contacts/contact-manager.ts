/**
 * Contact Manager (extracted from smart-router)
 * Gerencia contatos a partir do CONTATOS.md
 */

import { readFileSync, existsSync, watchFile, unwatchFile } from "node:fs";
import { normalizeBrazilianMobile } from "../utils.js";
import type { Contact } from "./types.js";

export class ContactManager {
  private contactsByPhone: Map<string, Contact> = new Map();
  private contactsByName: Map<string, Contact> = new Map();
  private allContacts: Contact[] = [];
  private contactsPath?: string;

  /**
   * Normaliza um número de telefone
   */
  normalizePhone(phone: string): string {
    // Remove tudo que não é número
    let normalized = phone.replace(/[^\d]/g, "");

    // Se começar com 0, remove
    if (normalized.startsWith("0")) {
      normalized = normalized.substring(1);
    }

    // Se não tiver código do país, adiciona 55 (Brasil)
    if (normalized.length <= 11) {
      normalized = "55" + normalized;
    }

    // Normalize BR mobile (strip 9th digit: 13 -> 12 digits)
    normalized = normalizeBrazilianMobile(normalized);

    return normalized;
  }

  /**
   * Gera variações de um número para busca
   */
  generateVariations(phone: string): string[] {
    const normalized = this.normalizePhone(phone);
    const variations = new Set<string>();

    variations.add(phone); // Original
    variations.add(normalized); // Normalizado
    variations.add("+" + normalized); // Com +
    variations.add(normalized.substring(2)); // Sem código país

    // Últimos 8-9 dígitos (número local)
    if (normalized.length >= 8) {
      variations.add(normalized.slice(-8));
      variations.add(normalized.slice(-9));
    }

    return Array.from(variations);
  }

  /**
   * Adiciona um contato
   */
  addContact(name: string, phones: string[], aliases?: string[], category?: string): void {
    const normalizedPhones = phones.map((p) => this.normalizePhone(p));
    const upperName = name.toUpperCase().trim();

    const contact: Contact = {
      name: upperName,
      phones,
      normalizedPhones,
      aliases: aliases?.map((a) => a.toUpperCase().trim()),
      category,
    };

    this.allContacts.push(contact);

    // Indexa por todas as variações de telefone
    for (const phone of phones) {
      const variations = this.generateVariations(phone);
      for (const variation of variations) {
        this.contactsByPhone.set(variation, contact);
      }
    }

    // Indexa por nome completo
    this.contactsByName.set(upperName, contact);

    // Indexa por aliases
    if (aliases) {
      for (const alias of aliases) {
        this.contactsByName.set(alias.toUpperCase().trim(), contact);
      }
    }

    // Indexa por primeiro nome (se não conflitar)
    const firstName = upperName.split(" ")[0];
    if (firstName !== upperName && !this.contactsByName.has(firstName)) {
      this.contactsByName.set(firstName, contact);
    }
  }

  /**
   * Busca contato por telefone
   */
  findByPhone(phone: string): Contact | undefined {
    const variations = this.generateVariations(phone);

    for (const variation of variations) {
      const contact = this.contactsByPhone.get(variation);
      if (contact) {
        return contact;
      }
    }

    return undefined;
  }

  /**
   * Busca contato por nome com fuzzy matching
   */
  findByName(name: string): Contact | undefined {
    const upperName = name.toUpperCase().trim();

    // 1. Match exato
    const exact = this.contactsByName.get(upperName);
    if (exact) {
      return exact;
    }

    // 2. Match por primeiro nome ou alias
    for (const contact of this.allContacts) {
      // Nome começa com o termo buscado
      if (contact.name.startsWith(upperName)) {
        return contact;
      }

      // Termo buscado está contido no nome
      if (contact.name.includes(upperName)) {
        return contact;
      }

      // Verifica aliases
      if (contact.aliases) {
        for (const alias of contact.aliases) {
          if (alias === upperName || alias.startsWith(upperName)) {
            return contact;
          }
        }
      }
    }

    // 3. Match por similaridade (Levenshtein simplificado)
    let bestMatch: Contact | undefined;
    let bestScore = 0;

    for (const contact of this.allContacts) {
      const score = this.similarityScore(upperName, contact.name);
      if (score > 0.7 && score > bestScore) {
        bestScore = score;
        bestMatch = contact;
      }
    }

    return bestMatch;
  }

  /**
   * Calcula similaridade entre duas strings (0-1)
   */
  private similarityScore(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    if (longer.length === 0) {
      return 1.0;
    }

    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  /**
   * Distância de Levenshtein
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1,
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }

  /**
   * Carrega contatos de um arquivo CONTATOS.md
   */
  loadFromMarkdown(filePath: string): void {
    if (!existsSync(filePath)) {
      console.warn(`[ContactManager] Arquivo não encontrado: ${filePath}`);
      return;
    }

    this.contactsPath = filePath;
    const content = readFileSync(filePath, "utf-8");
    this.parseMarkdown(content);
  }

  /**
   * Parser do CONTATOS.md
   */
  private parseMarkdown(content: string): void {
    // Limpa contatos existentes
    this.contactsByPhone.clear();
    this.contactsByName.clear();
    this.allContacts = [];

    const lines = content.split("\n");
    let currentName: string | null = null;
    let currentPhones: string[] = [];
    let currentAliases: string[] = [];
    let currentCategory: string | undefined;

    for (const line of lines) {
      // Detecta categoria (## 👨‍👩‍👧‍👦 Família)
      const categoryMatch = line.match(/^##\s+(?:[\p{Emoji}\s]*)?(.+)$/u);
      if (categoryMatch) {
        // Salva o contato anterior
        if (currentName && currentPhones.length > 0) {
          this.addContact(currentName, currentPhones, currentAliases, currentCategory);
        }
        currentCategory = categoryMatch[1].trim();
        currentName = null;
        currentPhones = [];
        currentAliases = [];
        continue;
      }

      // Detecta nome (### Nome ou **Nome**)
      const nameMatch = line.match(/^###\s+(.+)$/) || line.match(/^\*\*(.+?)\*\*/);
      if (nameMatch) {
        // Salva o contato anterior
        if (currentName && currentPhones.length > 0) {
          this.addContact(currentName, currentPhones, currentAliases, currentCategory);
        }
        currentName = nameMatch[1].trim();
        currentPhones = [];
        currentAliases = [];
        continue;
      }

      // Detecta telefone (WhatsApp: +55 69 9999-9999)
      const phoneMatch = line.match(/WhatsApp[:\s*]*([+\d\s\-()]+)/i);
      if (phoneMatch && currentName) {
        currentPhones.push(phoneMatch[1].trim());
      }

      // Detecta apelido (Apelidos: Apelido1, Apelido2)
      const aliasMatch = line.match(/Apelido[s]?[:\s]*(.+)/i);
      if (aliasMatch && currentName) {
        const aliases = aliasMatch[1].split(",").map((a) => a.trim());
        currentAliases.push(...aliases);
      }
    }

    // Salva o último contato
    if (currentName && currentPhones.length > 0) {
      this.addContact(currentName, currentPhones, currentAliases, currentCategory);
    }

    console.log(`[ContactManager] Carregados ${this.allContacts.length} contatos`);
  }

  /**
   * Ativa hot reload quando o arquivo muda
   */
  enableHotReload(): void {
    if (!this.contactsPath) {
      return;
    }

    watchFile(this.contactsPath, { interval: 5000 }, () => {
      console.log(`[ContactManager] CONTATOS.md modificado, recarregando...`);
      this.loadFromMarkdown(this.contactsPath!);
    });
  }

  /**
   * Desativa hot reload
   */
  disableHotReload(): void {
    if (!this.contactsPath) {
      return;
    }
    unwatchFile(this.contactsPath);
  }

  /**
   * Lista todos os contatos
   */
  listAll(): Contact[] {
    return [...this.allContacts];
  }

  /**
   * Formata número para exibição
   */
  formatPhone(phone: string): string {
    const normalized = this.normalizePhone(phone);
    if (normalized.length === 13) {
      // +55 69 99602-1005
      return `+${normalized.slice(0, 2)} ${normalized.slice(2, 4)} ${normalized.slice(4, 9)}-${normalized.slice(9)}`;
    }
    return "+" + normalized;
  }
}

// Singleton para uso global
let globalContactManager: ContactManager | null = null;

export function getContactManager(): ContactManager {
  if (!globalContactManager) {
    globalContactManager = new ContactManager();
  }
  return globalContactManager;
}

export function initContactManager(contactsPath: string): ContactManager {
  const manager = getContactManager();
  manager.loadFromMarkdown(contactsPath);
  manager.enableHotReload();
  return manager;
}
