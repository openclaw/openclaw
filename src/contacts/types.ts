/**
 * Contact types (extracted from smart-router)
 */

export interface Contact {
  /** Nome do contato (MAIÚSCULO para matching) */
  name: string;
  /** Lista de números de telefone (formato original) */
  phones: string[];
  /** Números normalizados (E.164 sem +) */
  normalizedPhones: string[];
  /** Apelidos alternativos para matching */
  aliases?: string[];
  /** Categoria do contato (família, trabalho, etc.) */
  category?: string;
}
