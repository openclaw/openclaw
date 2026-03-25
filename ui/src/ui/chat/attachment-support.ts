// Support multiple file types for webchat uploads (issue #54199)
// Original limitation only allowed image/* which prevented users from uploading documents, configs, logs, etc.
// Now supports images + common document/data/file types

export const CHAT_ATTACHMENT_ACCEPT = "image/*,.pdf,.zip,.txt,.md,.json,.csv,.yaml,.yml,.xml,.html,.css,.js,.ts,.jsx,.tsx,.py,.sh,.bat,.ps1,.rb,.go,.rs,.php,.c,.cpp,.h,.hpp,.java,.cs,.swift,.kt,.dart,.sql,.log,.env,.pem,.key,.cert,.csr,.cfg,.ini,.toml,.lock";

/**
 * Check if a MIME type is supported for chat attachments.
 * For issue #54199: now accepts all types since we validate by extension too.
 */
export function isSupportedChatAttachmentMimeType(mimeType: string | null | undefined): boolean {
  if (typeof mimeType !== "string") {
    return false;
  }
  
  // Allow image files by MIME type (original behavior preserved)
  if (mimeType.startsWith("image/")) {
    return true;
  }
  
  // Accept all other types - extension check provides additional validation
  return true;
}

/**
 * Check if a file extension is allowed for uploads.
 * This is the primary validation for non-image files (fixes issue #54199).
 */
export function isAllowedFileExtension(filename: string): boolean {
  const ext = filename.toLowerCase().slice((filename.lastIndexOf(".") - 1 >>> 0) + 2);
  if (!ext) {
    // No extension - be permissive for some cases
    return true;
  }
  
  // List of commonly used and safe file extensions
  const allowedExtensions = [
    // Images
    "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "tiff", "tif",
    
    // Archives
    "zip", "tar", "gz", "rar", "7z", "xz", "bz2",
    
    // Text & Code
    "txt", "md", "markdown", "rst", "asciidoc",
    "json", "csv", "tsv", "yaml", "yml", "xml", 
    "html", "htm", "xhtml", "css", 
    "js", "mjs", "ts", "jsx", "tsx", "vue", "svelte",
    "py", "py3", "ipyw",
    "sh", "bash", "zsh", "fish", "csh",
    "bat", "cmd", "ps1", "powershell",
    "rb", "ruby",
    "go", "golang",
    "rs", "rust",
    "php", "php3", "php4", "php5", "php7", "php8",
    "c", "cc", "cpp", "cxx", "c++",
    "h", "hh", "hpp", "hxx", "h++",
    "java", "jav",
    "cs", "csharp",
    "swift",
    "kt", "kotlin",
    "dart",
    "sql", "sqlite", "db",
    "log", "logs",
    
    // Config & Environment
    "env", "environment",
    "pem", "key", "cert", "crt", "csr",
    "cfg", "conf", "config", "ini", "toml",
    "lock",
    
    // Documentation
    "pdf", "doc", "docx", "odt", "rtf",
    "epub", "mobi",
  ];
  
  return allowedExtensions.includes(ext);
}
