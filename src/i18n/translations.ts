export type TranslationKey =
  | "error.config.missingParam"
  | "error.config.invalidValue"
  | "error.channel.notFound"
  | "error.channel.authFailed"
  | "error.cron.jobNotFound"
  | "error.cron.jobRunning"
  | "error.origin.notAllowed"
  | "success.cron.jobRemoved"
  | "success.cron.jobAdded"
  | "info.config.example"
  | "info.docs.link";

type Translations = Record<string, Record<TranslationKey, string>>;

export const translations: Translations = {
  en: {
    "error.config.missingParam": "Configuration error: missing required parameter '{{param}}'",
    "error.config.invalidValue": "Configuration error: invalid value for '{{param}}'",
    "error.channel.notFound": "Channel not found: {{channel}}",
    "error.channel.authFailed": "Authentication failed for channel: {{channel}}",
    "error.cron.jobNotFound": "Cron job not found: {{id}}",
    "error.cron.jobRunning": "Cron job is currently running, use --force to remove anyway",
    "error.origin.notAllowed": "Origin not allowed: {{origin}}",
    "success.cron.jobRemoved": "Successfully removed job: {{name}}",
    "success.cron.jobAdded": "Successfully added job: {{name}}",
    "info.config.example": "Example configuration:",
    "info.docs.link": "Documentation: {{url}}",
  },
  "zh-CN": {
    "error.config.missingParam": "配置错误: 缺少必需参数 '{{param}}'",
    "error.config.invalidValue": "配置错误: '{{param}}' 的值无效",
    "error.channel.notFound": "未找到通道: {{channel}}",
    "error.channel.authFailed": "通道认证失败: {{channel}}",
    "error.cron.jobNotFound": "未找到定时任务: {{id}}",
    "error.cron.jobRunning": "定时任务正在运行，使用 --force 强制删除",
    "error.origin.notAllowed": "不允许的来源: {{origin}}",
    "success.cron.jobRemoved": "成功删除任务: {{name}}",
    "success.cron.jobAdded": "成功添加任务: {{name}}",
    "info.config.example": "配置示例:",
    "info.docs.link": "文档: {{url}}",
  },
  "zh-TW": {
    "error.config.missingParam": "配置錯誤: 缺少必要參數 '{{param}}'",
    "error.config.invalidValue": "配置錯誤: '{{param}}' 的值無效",
    "error.channel.notFound": "未找到通道: {{channel}}",
    "error.channel.authFailed": "通道認證失敗: {{channel}}",
    "error.cron.jobNotFound": "未找到定時任務: {{id}}",
    "error.cron.jobRunning": "定時任務正在運行，使用 --force 強制刪除",
    "error.origin.notAllowed": "不允許的來源: {{origin}}",
    "success.cron.jobRemoved": "成功刪除任務: {{name}}",
    "success.cron.jobAdded": "成功添加任務: {{name}}",
    "info.config.example": "配置示例:",
    "info.docs.link": "文檔: {{url}}",
  },
  ja: {
    "error.config.missingParam": "設定エラー: 必須パラメータ '{{param}}' が見つかりません",
    "error.config.invalidValue": "設定エラー: '{{param}}' の値が無効です",
    "error.channel.notFound": "チャンネルが見つかりません: {{channel}}",
    "error.channel.authFailed": "チャンネルの認証に失敗しました: {{channel}}",
    "error.cron.jobNotFound": "Cronジョブが見つかりません: {{id}}",
    "error.cron.jobRunning": "Cronジョブは現在実行中です。--force を使用して強制削除してください",
    "error.origin.notAllowed": "許可されていないオリジン: {{origin}}",
    "success.cron.jobRemoved": "ジョブを削除しました: {{name}}",
    "success.cron.jobAdded": "ジョブを追加しました: {{name}}",
    "info.config.example": "設定例:",
    "info.docs.link": "ドキュメント: {{url}}",
  },
  ko: {
    "error.config.missingParam": "구성 오류: 필수 매개변수 '{{param}}'이(가) 누락되었습니다",
    "error.config.invalidValue": "구성 오류: '{{param}}'의 값이 잘못되었습니다",
    "error.channel.notFound": "채널을 찾을 수 없음: {{channel}}",
    "error.channel.authFailed": "채널 인증 실패: {{channel}}",
    "error.cron.jobNotFound": "Cron 작업을 찾을 수 없음: {{id}}",
    "error.cron.jobRunning": "Cron 작업이 현재 실행 중입니다. --force를 사용하여 강제로 제거하세요",
    "error.origin.notAllowed": "허용되지 않는 출처: {{origin}}",
    "success.cron.jobRemoved": "작업 제거 성공: {{name}}",
    "success.cron.jobAdded": "작업 추가 성공: {{name}}",
    "info.config.example": "구성 예시:",
    "info.docs.link": "문서: {{url}}",
  },
  es: {
    "error.config.missingParam": "Error de configuración: falta el parámetro requerido '{{param}}'",
    "error.config.invalidValue": "Error de configuración: valor inválido para '{{param}}'",
    "error.channel.notFound": "Canal no encontrado: {{channel}}",
    "error.channel.authFailed": "Error de autenticación del canal: {{channel}}",
    "error.cron.jobNotFound": "Trabajo cron no encontrado: {{id}}",
    "error.cron.jobRunning": "El trabajo cron se está ejecutando, use --force para eliminar de todos modos",
    "error.origin.notAllowed": "Origen no permitido: {{origin}}",
    "success.cron.jobRemoved": "Trabajo eliminado exitosamente: {{name}}",
    "success.cron.jobAdded": "Trabajo agregado exitosamente: {{name}}",
    "info.config.example": "Ejemplo de configuración:",
    "info.docs.link": "Documentación: {{url}}",
  },
  fr: {
    "error.config.missingParam": "Erreur de configuration: paramètre requis '{{param}}' manquant",
    "error.config.invalidValue": "Erreur de configuration: valeur invalide pour '{{param}}'",
    "error.channel.notFound": "Canal non trouvé: {{channel}}",
    "error.channel.authFailed": "Échec de l'authentification du canal: {{channel}}",
    "error.cron.jobNotFound": "Tâche cron non trouvée: {{id}}",
    "error.cron.jobRunning": "La tâche cron est en cours d'exécution, utilisez --force pour supprimer quand même",
    "error.origin.notAllowed": "Origine non autorisée: {{origin}}",
    "success.cron.jobRemoved": "Tâche supprimée avec succès: {{name}}",
    "success.cron.jobAdded": "Tâche ajoutée avec succès: {{name}}",
    "info.config.example": "Exemple de configuration:",
    "info.docs.link": "Documentation: {{url}}",
  },
  de: {
    "error.config.missingParam": "Konfigurationsfehler: Erforderlicher Parameter '{{param}}' fehlt",
    "error.config.invalidValue": "Konfigurationsfehler: Ungültiger Wert für '{{param}}'",
    "error.channel.notFound": "Kanal nicht gefunden: {{channel}}",
    "error.channel.authFailed": "Kanal-Authentifizierung fehlgeschlagen: {{channel}}",
    "error.cron.jobNotFound": "Cron-Job nicht gefunden: {{id}}",
    "error.cron.jobRunning": "Cron-Job läuft gerade, verwenden Sie --force zum Entfernen",
    "error.origin.notAllowed": "Ursprung nicht erlaubt: {{origin}}",
    "success.cron.jobRemoved": "Job erfolgreich entfernt: {{name}}",
    "success.cron.jobAdded": "Job erfolgreich hinzugefügt: {{name}}",
    "info.config.example": "Konfigurationsbeispiel:",
    "info.docs.link": "Dokumentation: {{url}}",
  },
};
