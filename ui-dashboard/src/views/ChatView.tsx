import { useState } from 'react';
import { Sidebar } from '../components/layout/Sidebar';
import { ContextPanel, ContextSection, ContextRow } from '../components/layout/ContextPanel';
import { ThreeColumnLayout } from '../components/layout/ThreeColumnLayout';
import { Avatar, Badge, Button, Input } from '../components/ui';
import styles from './ChatView.module.css';

interface Message {
  id: string;
  sender: 'user' | 'lead' | 'worker';
  name: string;
  content: string;
  timestamp: string;
}

const mockTracks = [
  { id: '1', name: 'Add dark mode toggle', status: 'active' as const, taskCount: 3 },
  { id: '2', name: 'Fix login validation', status: 'pending' as const, taskCount: 1 },
  { id: '3', name: 'Update API endpoints', status: 'idle' as const },
];

const mockWorkers = [
  { id: 'w1', name: 'Worker 1', status: 'active' as const, task: 'Implementing theme system...' },
  { id: 'w2', name: 'Worker 2', status: 'active' as const, task: 'Writing unit tests...' },
  { id: 'w3', name: 'Worker 3', status: 'idle' as const },
];

const mockMessages: Message[] = [
  {
    id: '1',
    sender: 'user',
    name: 'You',
    content: 'Can you add a dark mode toggle to the settings page?',
    timestamp: '2:30 PM',
  },
  {
    id: '2',
    sender: 'lead',
    name: 'Lead Agent',
    content: "I'll break this down into subtasks and delegate to workers. Here's my plan:\n\n1. Create theme context and provider\n2. Add toggle component to settings\n3. Persist preference to localStorage",
    timestamp: '2:31 PM',
  },
  {
    id: '3',
    sender: 'worker',
    name: 'Worker 1',
    content: 'Created ThemeContext with useTheme hook. The provider wraps the app and exposes toggle function.',
    timestamp: '2:35 PM',
  },
];

export function ChatView() {
  const [selectedTrack, setSelectedTrack] = useState('1');
  const [inputValue, setInputValue] = useState('');

  return (
    <ThreeColumnLayout
      sidebar={
        <Sidebar
          tracks={mockTracks}
          workers={mockWorkers}
          reviewCount={2}
          selectedTrackId={selectedTrack}
          onTrackSelect={setSelectedTrack}
        />
      }
      main={
        <div className={styles.chatContainer}>
          <div className={styles.messages}>
            {mockMessages.map((msg) => (
              <div key={msg.id} className={styles.message}>
                <div className={styles.messageHeader}>
                  <Avatar
                    variant={msg.sender === 'user' ? 'user' : msg.sender === 'lead' ? 'lead' : 'worker'}
                    label={msg.name}
                  />
                  <span className={styles.messageSender}>{msg.name}</span>
                  <span className={styles.messageTime}>{msg.timestamp}</span>
                </div>
                <div className={styles.messageContent}>
                  {msg.content.split('\n').map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className={styles.inputArea}>
            <Input
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Describe what you want to build..."
              className={styles.input}
            />
            <Button>Send</Button>
          </div>
        </div>
      }
      context={
        <ContextPanel>
          <ContextSection title="Current Track">
            <ContextRow label="Status" value={<Badge variant="success">Active</Badge>} />
            <ContextRow label="Started" value="2:30 PM" />
            <ContextRow label="Tokens" value="12.4k" />
            <ContextRow label="Cost" value="$0.18" />
          </ContextSection>
          <ContextSection title="Active Workers">
            <ContextRow label="Worker 1" value={<Badge variant="success">Running</Badge>} />
            <ContextRow label="Worker 2" value={<Badge variant="success">Running</Badge>} />
          </ContextSection>
          <ContextSection title="Context Files">
            <div className={styles.fileList}>
              <div className={styles.fileItem}>src/contexts/ThemeContext.tsx</div>
              <div className={styles.fileItem}>src/components/ThemeToggle.tsx</div>
              <div className={styles.fileItem}>src/styles/variables.css</div>
            </div>
          </ContextSection>
        </ContextPanel>
      }
    />
  );
}
