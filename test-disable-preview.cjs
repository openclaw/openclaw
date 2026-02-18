// Простой тест для проверки disableWebPagePreview
const fs = require('fs');

// Читаем файл send.ts и проверяем что наши изменения на месте
const sendTsContent = fs.readFileSync('src/telegram/send.ts', 'utf8');

console.log('🔍 Проверяем изменения в send.ts:');

// Проверяем что добавлен новый параметр в тип
if (sendTsContent.includes('disableWebPagePreview?: boolean;')) {
  console.log('✅ Параметр disableWebPagePreview добавлен в TelegramSendOpts');
} else {
  console.log('❌ Параметр disableWebPagePreview НЕ найден в TelegramSendOpts');
}

// Проверяем что добавлена логика в sendParams
if (sendTsContent.includes('disable_web_page_preview: true')) {
  console.log('✅ Логика disable_web_page_preview добавлена в параметры');
} else {
  console.log('❌ Логика disable_web_page_preview НЕ найдена в параметрах');
}

// Считаем количество вхождений нашей логики
const occurrences = (sendTsContent.match(/opts\.disableWebPagePreview === true/g) || []).length;
console.log(`✅ Найдено ${occurrences} мест с логикой disableWebPagePreview (ожидается 3)`);

console.log('\n🔍 Проверяем другие файлы:');

// Проверяем message-tool.ts
const messageToolContent = fs.readFileSync('src/agents/tools/message-tool.ts', 'utf8');
if (messageToolContent.includes('disableWebPagePreview: Type.Optional(Type.Boolean())')) {
  console.log('✅ disableWebPagePreview добавлен в TypeBox схему message-tool.ts');
} else {
  console.log('❌ disableWebPagePreview НЕ найден в message-tool.ts');
}

// Проверяем telegram-actions.ts
const telegramActionsContent = fs.readFileSync('src/agents/tools/telegram-actions.ts', 'utf8');
if (telegramActionsContent.includes('params.disableWebPagePreview')) {
  console.log('✅ disableWebPagePreview добавлен в telegram-actions.ts');
} else {
  console.log('❌ disableWebPagePreview НЕ найден в telegram-actions.ts');
}

console.log('\n🎉 Проверка завершена!');