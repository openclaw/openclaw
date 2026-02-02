/**
 * Utility functions for WhatsApp URL handling
 */

/**
 * Strip markdown formatting from URLs in text
 * This prevents WhatsApp validation errors when markdown wraps URLs
 *
 * Examples:
 * - **https://example.com** → https://example.com
 * - [link](https://example.com) → https://example.com
 * - *https://example.com* → https://example.com
 */
export function stripMarkdownFromUrls(text: string): string {
  if (!text) return text;
  
  let result = text;
  
  // Strip **bold** or ***bold-italic*** around URLs
  result = result.replace(/\*{2,3}(https?:\/\/[^\s*)]+)\*{2,3}/g, '$1');
  
  // Strip __bold__ (underscore) around URLs  
  result = result.replace(/__+(https?:\/\/[^\s_)]+)__+/g, '$1');
  
  // Strip *italic* around URLs
  result = result.replace(/\*(https?:\/\/[^\s*)]+)\*/g, '$1');
  
  // Strip _italic_ (underscore) around URLs
  result = result.replace(/_(https?:\/\/[^\s_)]+)_/g, '$1');
  
  // Strip markdown link syntax but keep URL: [text](https://url) → https://url
  result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$2');
  
  return result;
}
